// A WebRTC data channel between two browsers, set up with exactly two blobs:
// the host's offer and the guest's answer. ICE candidates are gathered
// before each blob is handed out (no trickle), so whatever carries the blobs
// (a link and a pasted code, or a signaling server) needs one round trip and
// no live connection.

/** Public STUN so peers behind home routers can find each other. No TURN yet. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
/** Stop waiting for more ICE candidates after this long; what we have is usually enough. */
const GATHER_TIMEOUT_MS = 4000;
/** A peer that's been unreachable this long is gone. */
const DISCONNECT_GRACE_MS = 5000;

export interface PeerLink {
  send(message: unknown): void;
  onMessage: (message: unknown) => void;
  onClose: () => void;
  close(): void;
}

/** Host side: an offer to hand to one guest, and a way to accept its answer. */
export async function createOffer(): Promise<{ offer: string; accept(answer: string): Promise<PeerLink> }> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("uptime", { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return {
    offer: await encode(pc.localDescription!),
    async accept(answer) {
      await pc.setRemoteDescription(await decode(answer));
      return link(pc, channel);
    },
  };
}

/** Guest side: answer a host's offer. The link opens once the host accepts the answer. */
export async function answerOffer(offer: string): Promise<{ answer: string; link: Promise<PeerLink> }> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = new Promise<RTCDataChannel>((resolve) => {
    pc.addEventListener("datachannel", (event) => resolve(event.channel));
  });
  await pc.setRemoteDescription(await decode(offer));
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { answer: await encode(pc.localDescription!), link: channel.then((c) => link(pc, c)) };
}

function link(pc: RTCPeerConnection, channel: RTCDataChannel): Promise<PeerLink> {
  return new Promise((resolve, reject) => {
    const peer: PeerLink = {
      send: (message) => {
        if (channel.readyState === "open") channel.send(JSON.stringify(message));
      },
      onMessage: () => {},
      onClose: () => {},
      close: () => {
        channel.close();
        pc.close();
      },
    };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      peer.onClose();
    };
    channel.addEventListener("message", (event) => peer.onMessage(JSON.parse(String(event.data))));
    channel.addEventListener("close", close);
    let grace: ReturnType<typeof setTimeout> | undefined;
    pc.addEventListener("connectionstatechange", () => {
      clearTimeout(grace);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") close();
      if (pc.connectionState === "failed") reject(new Error("Couldn't connect to the other player."));
      // A tab that closed or lost its network only shows up as "disconnected",
      // and "failed" can take half a minute. Give it a moment to come back.
      if (pc.connectionState === "disconnected") grace = setTimeout(close, DISCONNECT_GRACE_MS);
    });
    if (channel.readyState === "open") resolve(peer);
    else channel.addEventListener("open", () => resolve(peer), { once: true });
  });
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, GATHER_TIMEOUT_MS);
  });
}

// SDP is a few KB of repetitive text: deflate + base64url keeps a link short.

async function encode(description: RTCSessionDescription): Promise<string> {
  const json = JSON.stringify({ type: description.type, sdp: description.sdp });
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decode(code: string): Promise<RTCSessionDescriptionInit> {
  const base64 = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(stream).text()) as RTCSessionDescriptionInit;
}
