<template>
  <div id="app">
    <h1>高速 P2P 大文件传输</h1>

    <div v-if="!isReceiving">
      <input type="file" @change="onFileChange" />
      <button @click="startTransfer" :disabled="!file || sending">开始传输</button>

      <div v-if="file">
        <p>文件名: {{ file.name }}</p>
        <p>发送进度: {{ progress }}%</p>
        <progress :value="progress" max="100"></progress>
      </div>
    </div>

    <div v-if="isReceiving">
      <p>接收文件: {{ fileName }}</p>
      <p>接收进度: {{ downloadProgress }}%</p>
      <progress :value="downloadProgress" max="100"></progress>
      <button v-if="downloadUrl" @click="downloadFile">点击下载文件</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const file = ref(null)
const progress = ref(0)
const downloadProgress = ref(0)
const isReceiving = ref(false)
const fileName = ref('')
const downloadUrl = ref('')

let ws = null
let pc = null
let dataChannels = []
const SLICE_SIZE = 512 * 1024 // 512KB 每片
const CHANNEL_COUNT = 4

// 发送端状态
let sending = ref(false)

// 接收端用内存缓存文件片段
let receivedSlices = []
let totalSlices = 0
let sliceSize = 0

const onFileChange = (e) => {
  file.value = e.target.files[0]
  progress.value = 0
}

function waitForSocketOpen(ws) {
  return new Promise(resolve => {
    if (ws.readyState === WebSocket.OPEN) resolve()
    else ws.onopen = () => resolve()
  })
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function setupWebSocket() {
  return new Promise(resolve => {
    if (ws) {
      ws.close()
      ws = null
    }
    ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

    ws.onopen = () => {
      console.log('[WebSocket] 连接成功')
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
        } catch(e) {
          console.error('ICE candidate 错误:', e)
        }
      } else if (msg.type === 'fileMeta') {
        // 接收端收到文件元信息
        startReceiving(msg)
      } else if (msg.type === 'offer') {
        // 被动接收端流程
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })
        pc.ondatachannel = setupDataChannelReceiver
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))
      }
    }

    ws.onclose = () => {
      console.warn('[WebSocket] 断开，3秒后尝试重连')
      setTimeout(() => setupWebSocket(), 3000)
    }

    ws.onerror = (err) => {
      console.error('[WebSocket] 错误:', err)
      ws.close()
    }
  })
}

async function startTransfer() {
  if (!ws || ws.readyState >= WebSocket.CLOSING) {
    await setupWebSocket()
  }

  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })
  dataChannels = []
  const openPromises = []

  for(let i=0; i<CHANNEL_COUNT; i++) {
    const ch = pc.createDataChannel(`ch-${i}`, { ordered: true, reliable: true })
    ch.binaryType = 'arraybuffer'
    dataChannels.push(ch)
    openPromises.push(new Promise(resolve => {
      ch.onopen = () => {
        console.log(`[DataChannel] ${ch.label} opened`)
        resolve()
      }
    }))
  }

  pc.onicecandidate = (e) => {
    if(e.candidate) ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer }))

  await Promise.all(openPromises)
  console.log('🟢 所有通道打开，开始发送文件')
  sending.value = true
  await sendFileParallel()
  sending.value = false
  alert('✅ 文件发送完成')
}

async function sendFileParallel() {
  const f = file.value
  const total = Math.ceil(f.size / SLICE_SIZE)
  progress.value = 0

  ws.send(JSON.stringify({
    type: 'fileMeta',
    name: f.name,
    size: f.size,
    sliceSize: SLICE_SIZE,
    totalSlices: total,
    channelCount: dataChannels.length
  }))

  for(let i=0; i<total; i++) {
    const start = i * SLICE_SIZE
    const end = Math.min(f.size, start + SLICE_SIZE)
    const blob = f.slice(start, end)
    const buffer = await blob.arrayBuffer()

    const header = new Uint32Array([i])
    const payload = new Uint8Array(header.byteLength + buffer.byteLength)
    payload.set(new Uint8Array(header.buffer), 0)
    payload.set(new Uint8Array(buffer), header.byteLength)

    const ch = dataChannels[i % dataChannels.length]

    while(ch.readyState !== 'open') {
      console.log(`[INFO] 等待 ${ch.label} 通道打开`)
      await sleep(100)
    }

    ch.send(payload)
    progress.value = ((i + 1) / total * 100).toFixed(2)
  }
}

// 接收端相关

function setupDataChannelReceiver(event) {
  const channel = event.channel
  channel.binaryType = 'arraybuffer'

  channel.onmessage = async (evt) => {
    const buf = evt.data
    const view = new DataView(buf)
    const index = view.getUint32(0, false)
    const data = buf.slice(4)
    receivedSlices[index] = data
    downloadProgress.value = ((receivedSlices.filter(Boolean).length / totalSlices) * 100).toFixed(2)

    if(receivedSlices.filter(Boolean).length === totalSlices) {
      isReceiving.value = false
      assembleAndCreateDownload()
    }
  }
}

function startReceiving(meta) {
  fileName.value = meta.name
  totalSlices = meta.totalSlices
  sliceSize = meta.sliceSize
  isReceiving.value = true
  downloadProgress.value = 0
  receivedSlices = new Array(totalSlices)
  downloadUrl.value = ''
}

function assembleAndCreateDownload() {
  // 拼接所有 ArrayBuffer 片段
  const buffers = receivedSlices
  const totalLength = buffers.reduce((acc, curr) => acc + curr.byteLength, 0)
  const tmp = new Uint8Array(totalLength)

  let offset = 0
  for(const buf of buffers) {
    tmp.set(new Uint8Array(buf), offset)
    offset += buf.byteLength
  }

  const blob = new Blob([tmp])
  downloadUrl.value = URL.createObjectURL(blob)
}

function downloadFile() {
  const a = document.createElement('a')
  a.href = downloadUrl.value
  a.download = fileName.value || 'downloaded_file'
  a.click()
  URL.revokeObjectURL(downloadUrl.value)
  downloadUrl.value = ''
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
