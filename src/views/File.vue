<template>
  <div id="app">
    <h1>高速 P2P 大文件传输1</h1>

    <!-- 发送端文件选择 + 发送按钮 -->
    <div v-if="!sending && !receiving">
      <input type="file" @change="onFileChange" />
      <button @click="startTransfer" :disabled="!file">开始传输</button>
    </div>

    <!-- 发送端进度显示 -->
    <div v-if="sending">
      <p>发送文件: {{ file.name }}</p>
      <p>发送进度: {{ progress }}%</p>
      <progress :value="progress" max="100"></progress>
    </div>

    <!-- 接收端进度显示 -->
    <div v-if="receiving">
      <p>接收文件: {{ incomingFileMeta.name }}</p>
      <p>接收进度: {{ downloadProgress }}%</p>
      <progress :value="downloadProgress" max="100"></progress>
      <div v-if="downloadUrl">
        <a :href="downloadUrl" :download="incomingFileMeta.name">点击下载文件</a>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const file = ref(null)
const progress = ref(0)
const receiving = ref(false)
const sending = ref(false)
const downloadProgress = ref(0)
const incomingFileMeta = ref(null)
const downloadUrl = ref('')

const SLICE_SIZE = 512 * 1024
const CHANNEL_COUNT = 4

let ws, pc
let buffers = []
let totalSlices = 0
let receivedCount = 0

const onFileChange = (e) => {
  file.value = e.target.files[0]
}

function setupWebSocket() {
  return new Promise((resolve) => {
    if (ws) ws.close()
    ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

    ws.onopen = () => {
      console.log('[WebSocket] 连接成功')
      resolve()
    }

    ws.onmessage = async (event) => {
      if (event.data === 'pong') return // 心跳包忽略
      const msg = JSON.parse(event.data)
      if (msg.type === 'offer') {
        // 被动接收方收到 offer，创建 PC 回答
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))

        pc.onicecandidate = (e) => {
          if (e.candidate) {
            ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
          }
        }

        pc.ondatachannel = onReceiveChannel
      } else if (msg.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
      } else if (msg.type === 'candidate') {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } catch (e) {
          console.error('ICE candidate error:', e)
        }
      } else if (msg.type === 'fileMeta') {
        // 收到文件元信息，准备接收
        incomingFileMeta.value = msg
        receiving.value = true
        buffers = new Array(msg.totalSlices)
        totalSlices = msg.totalSlices
        receivedCount = 0
        downloadProgress.value = 0
      }
    }

    ws.onclose = () => {
      console.warn('[WebSocket] 断开，尝试重连')
      setTimeout(setupWebSocket, 3000)
    }

    ws.onerror = (err) => {
      console.error('[WebSocket] 错误:', err)
      ws.close()
    }
  })
}

const onReceiveChannel = (event) => {
  const channel = event.channel
  channel.binaryType = 'arraybuffer'
  channel.onmessage = async (event) => {
    const buf = event.data
    const view = new DataView(buf)
    const index = view.getUint32(0, false) // 前4字节是片段序号
    const data = buf.slice(4)
    buffers[index] = data
    receivedCount++
    downloadProgress.value = ((receivedCount / totalSlices) * 100).toFixed(2)

    if (receivedCount === totalSlices) {
      // 所有片段接收完，合并生成Blob URL
      const blob = new Blob(buffers)
      downloadUrl.value = URL.createObjectURL(blob)
      receiving.value = false
      incomingFileMeta.value = null
      alert('✅ 文件接收完成，点击下载链接保存文件')
    }
  }
}

const startTransfer = async () => {
  if (!ws || ws.readyState >= WebSocket.CLOSING) {
    await setupWebSocket()
  }

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

  const channels = []
  const openPromises = []

  for (let i = 0; i < CHANNEL_COUNT; i++) {
    const ch = pc.createDataChannel(`ch-${i}`, { ordered: true, reliable: true })
    ch.binaryType = 'arraybuffer'
    channels.push(ch)

    openPromises.push(new Promise((resolve) => {
      ch.onopen = () => {
        console.log(`[DataChannel] ${ch.label} opened`)
        resolve()
      }
    }))
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer }))

  await Promise.all(openPromises)
  sending.value = true
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
    const blob = f.slice(start, end)
    const buffer = await blob.arrayBuffer()

    const header = new Uint32Array([i])
    const payload = new Uint8Array(header.byteLength + buffer.byteLength)
    payload.set(new Uint8Array(header.buffer), 0)
    payload.set(new Uint8Array(buffer), header.byteLength)

    const ch = channels[i % channels.length]

    if (ch.readyState === 'open') {
      ch.send(payload)
    } else {
      console.warn(`[WARN] Channel ${ch.label} not open, skipping slice ${i}`)
    }

    sent++
    progress.value = ((sent / total) * 100).toFixed(2)
  }

  sending.value = false
  alert('✅ 文件发送完成')
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

a {
  display: inline-block;
  margin-top: 1em;
  padding: 0.5em 1em;
  background: #2c7;
  color: white;
  text-decoration: none;
  border-radius: 4px;
}
</style>
