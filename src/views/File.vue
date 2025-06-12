<template>
  <div id="app">
    <h1>高速 P2P 大文件传输</h1>

    <input type="file" @change="onFileChange" />
    <button @click="startTransfer" :disabled="!file"> 开始传输 </button>

    <div v-if="file">
      <p>文件名: {{ file.name }}</p>
      <p>发送进度: {{ progress }}%</p>
      <progress :value="progress" max="100"></progress>
    </div>

    <div v-if="pendingMeta && !writer">
      <p>接收文件: {{ pendingMeta.name }}</p>
      <button @click="startReceiving">选择保存地方，开始接收</button>
    </div>

    <div v-if="writer">
      <p>正在接收: {{ fileName }}</p>
      <p>接收进度: {{ downloadProgress }}%</p>
      <progress :value="downloadProgress" max="100"></progress>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const file = ref(null)
const progress = ref(0)
const downloadProgress = ref(0)
const receiving = ref(false)
const fileName = ref('')
const pendingMeta = ref(null)

let ws, pc
let SLICE_SIZE = 512 * 1024
let CHANNEL_COUNT = 4

let writer = null
let sliceSize = 0
let totalSlices = 0
let receivedCount = 0

const onFileChange = (e) => {
  file.value = e.target.files[0]
}

const waitForSocketOpen = (ws) => new Promise((resolve) => {
  ws.readyState === WebSocket.OPEN ? resolve() : (ws.onopen = resolve)
})

let heartbeatTimer = null
let reconnectTimer = null

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send('ping')
    }
  }, 20000)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

function setupWebSocket() {
  return new Promise((resolve) => {
    if (ws) ws.close()
    ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

    ws.onopen = () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      console.log('[WebSocket] 连接成功')
      startHeartbeat()
      resolve()
    }

    ws.onmessage = async (event) => {
      if (event.data === 'pong') return
      const msg = JSON.parse(event.data)

      if (msg.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
      } else if (msg.type === 'candidate') {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } catch (e) {
          console.error('ICE candidate error:', e)
        }
      } else if (msg.type === 'fileMeta') {
        pendingMeta.value = msg
        fileName.value = msg.name
      } else if (msg.type === 'offer') {
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))
        setupReceiverChannels()
      }
    }

    ws.onclose = () => {
      console.warn('[WebSocket] 断开，3秒后重连')
      stopHeartbeat()
      reconnectTimer = setTimeout(() => setupWebSocket(), 3000)
    }

    ws.onerror = (err) => {
      console.error('[WebSocket] 错误:', err)
      ws.close()
    }
  })
}

const startTransfer = async () => {
  if (!ws || ws.readyState >= WebSocket.CLOSING) await setupWebSocket()

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })
  const channels = []
  const openPromises = []

  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const ch = pc.createDataChannel(`ch-${i}`, { ordered: true, reliable: true })
    ch.binaryType = 'arraybuffer'
    channels.push(ch)
    openPromises.push(new Promise((resolve) => ch.onopen = resolve))
  }

  pc.onicecandidate = (e) => e.candidate && ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer }))

  await Promise.all(openPromises)
  sendFileParallel(channels)
}

const sendFileParallel = async (channels) => {
  const f = file.value
  const total = Math.ceil(f.size / SLICE_SIZE)
  let sent = 0

  ws.send(JSON.stringify({
    type: 'fileMeta',
    name: f.name,
    size: f.size,
    sliceSize: SLICE_SIZE,
    totalSlices: total,
    channelCount: channels.length
  }))

  for (let i = 0; i < total; i++) {
    const start = i * SLICE_SIZE
    const end = Math.min(f.size, start + SLICE_SIZE)
    const buffer = await f.slice(start, end).arrayBuffer()
    const header = new Uint32Array([i])
    const payload = new Uint8Array(header.byteLength + buffer.byteLength)
    payload.set(new Uint8Array(header.buffer), 0)
    payload.set(new Uint8Array(buffer), header.byteLength)
    const ch = channels[i % channels.length]
    if (ch.readyState === 'open') ch.send(payload)
    sent++
    progress.value = ((sent / total) * 100).toFixed(2)
  }
}

const setupReceiverChannels = () => {
  pc.ondatachannel = (event) => {
    const channel = event.channel
    channel.binaryType = 'arraybuffer'
    channel.onmessage = async (event) => {
      if (!writer) return
      const buf = event.data
      const view = new DataView(buf)
      const index = view.getUint32(0, false)
      const data = buf.slice(4)
      await writer.write({ type: 'write', position: index * sliceSize, data })
      receivedCount++
      downloadProgress.value = ((receivedCount / totalSlices) * 100).toFixed(2)
      if (receivedCount === totalSlices) {
        await writer.close()
        writer = null
        pendingMeta.value = null
        alert('✅ 文件接收完成')
      }
    }
  }
}

const startReceiving = async () => {
  try {
    const meta = pendingMeta.value
    const handle = await window.showSaveFilePicker({
      suggestedName: meta.name
    })
    const stream = await handle.createWritable()
    writer = stream.getWriter()
    sliceSize = meta.sliceSize
    totalSlices = meta.totalSlices
    receivedCount = 0
  } catch (e) {
    console.error('❌ 选择保存失败', e)
  }
}

onMounted(() => {
  setupWebSocket()
})
</script>

<style>
#app {
  max-width: 600px;
  margin: auto;
  font-family: Arial, sans-serif;
  padding: 2rem;
}
progress {
  width: 100%;
  height: 20px;
}
</style>