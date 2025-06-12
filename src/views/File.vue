<template>
  <div id="app">
    <h1>高速 P2P 大文件传输</h1>

    <div v-if="!file && !receiving && !incomingFileMeta">
      <input type="file" @change="onFileChange" />
      <button @click="startTransfer" :disabled="!file">开始传输</button>
    </div>

    <div v-if="file">
      <p>发送文件: {{ file.name }}</p>
      <p>发送进度: {{ progress }}%</p>
      <progress :value="progress" max="100"></progress>
    </div>

    <div v-if="incomingFileMeta && !receiving">
      <p>📦 收到文件请求: {{ incomingFileMeta.name }}</p>
      <button @click="acceptAndStartReceiving">开始接收</button>
    </div>

    <div v-if="receiving">
      <p>接收文件: {{ incomingFileMeta.name }}</p>
      <p>接收进度: {{ downloadProgress }}%</p>
      <progress :value="downloadProgress" max="100"></progress>
      <button v-if="downloadUrl" @click="downloadFile">点击下载文件</button>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'

const file = ref(null)
const progress = ref(0)
const downloadProgress = ref(0)
const receiving = ref(false)
const incomingFileMeta = ref(null) // {name, size, sliceSize, totalSlices, channelCount}

let ws = null
let pc = null
let SLICE_SIZE = 512 * 1024
let CHANNEL_COUNT = 4

let receivedCount = 0
let receivedSlices = []
let downloadUrl = ref('')

const onFileChange = (e) => {
  file.value = e.target.files[0]
  progress.value = 0
}

const waitForSocketOpen = (ws) =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.OPEN) resolve()
    else ws.onopen = () => resolve()
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
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        console.warn('[WebSocket] 非 JSON 消息:', event.data)
        return
      }

      if (msg.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
      } else if (msg.type === 'candidate') {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } catch (e) {
          console.error('ICE candidate error:', e)
        }
      } else if (msg.type === 'fileMeta') {
        // 收到文件元信息，提示接收
        incomingFileMeta.value = msg
      } else if (msg.type === 'offer') {
        // 被动接收方收到 offer，建立连接并发 answer
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

        pc.ondatachannel = onDataChannelHandler

        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))
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

onMounted(() => {
  setupWebSocket()
})

async function startTransfer() {
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

    openPromises.push(
      new Promise((resolve) => {
        ch.onopen = () => {
          console.log(`[DataChannel] ${ch.label} 已打开`)
          resolve()
        }
      })
    )
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
  console.log('🟢 所有通道打开，开始并行发送文件')
  sendFileParallel(channels)
}

async function sendFileParallel(channels) {
  const f = file.value
  const total = Math.ceil(f.size / SLICE_SIZE)
  let sent = 0

  ws.send(
    JSON.stringify({
      type: 'fileMeta',
      name: f.name,
      size: f.size,
      sliceSize: SLICE_SIZE,
      totalSlices: total,
      channelCount: channels.length,
    })
  )

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
      console.warn(`[WARN] 通道 ${ch.label} 非 open 状态，跳过片段 ${i}`)
    }

    sent++
    progress.value = ((sent / total) * 100).toFixed(2)
  }
}

function onDataChannelHandler(event) {
  const channel = event.channel
  channel.binaryType = 'arraybuffer'

  channel.onmessage = async (event) => {
    const buf = event.data
    const view = new DataView(buf)
    const index = view.getUint32(0, false)
    const data = buf.slice(4)

    receivedSlices[index] = data
    receivedCount++
    downloadProgress.value = ((receivedCount / incomingFileMeta.value.totalSlices) * 100).toFixed(2)

    if (receivedCount === incomingFileMeta.value.totalSlices) {
      receiving.value = false

      const blob = new Blob(receivedSlices)
      downloadUrl.value = URL.createObjectURL(blob)
      alert('✅ 文件接收完成，点击下载按钮保存文件')
    }
  }
}

function acceptAndStartReceiving() {
  if (!incomingFileMeta.value) return
  receiving.value = true
  receivedCount = 0
  receivedSlices = new Array(incomingFileMeta.value.totalSlices)
  downloadProgress.value = 0

  // 创建 RTCPeerConnection 和回答offer已在 ws.onmessage中处理

  // 这里主要是显示“开始接收”按钮控制的开关
}

function downloadFile() {
  const a = document.createElement('a')
  a.href = downloadUrl.value
  a.download = incomingFileMeta.value.name || 'download'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
  incomingFileMeta.value = null
  receiving.value = false
  receivedSlices = []
  receivedCount = 0
}
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
