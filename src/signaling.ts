// signaling.ts
const ws = new WebSocket('ws://59.110.35.198/wgk/ws');

ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  // 回调处理，比如接收 offer/answer/ice
};

export function sendSignal(to: string, data: any) {
  ws.send(JSON.stringify({ to, data }));
}
