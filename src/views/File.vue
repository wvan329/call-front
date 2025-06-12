<template>
  <div id="app">
    <h1>高速 P2P 大文件传输123</h1>

    <div v-if="!isReceiver">
      <input type="file" @change="onFileChange" />
      <button @click="startTransfer" :disabled="!file || sending">开始传输</button>
      <div v-if="file">
        <p>文件名: {{ file.name }}</p>
        <p>发送进度: {{ progress }}%</p>
        <progress :value="progress" max="100"></progress>
      </div>
    </div>

    <div v-else>
      <p>接收文件名: {{ fileName || '等待文件...' }}</p>
      <p>接收进度: {{ downloadProgress }}%</p>
      <progress :value="downloadProgress" max="100"></progress>
      <button v-if="downloadReady" @click="downloadFile">下载文件</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'

const file = ref(null)
const progress = ref(0)
const downloadProgress = ref(0)
const sending = ref(false)
const isReceiver = ref(false) // 用来区分接收端还是发送端，手动修改或者用URL参数
const fileName = ref('')
const downloadReady = ref(false)

const SLICE_SIZE = 512 * 1024 // 512KB切片
const CHANNEL_COUNT = 4

let ws = null
let pc = null
let dataChannels = []
let receivedBuffers = []
let totalSlices = 0
let sliceSize = 0
let receivedCount = 0

// 发送端 - 选文件
function onFileChange(e) {
  file.value = e.target.files[0]
  progress.value = 0
}

// WebSocket 连接及信令管理
function setupWebSocket() {
  return new Promise((resolve) => {
    if (ws) {
      ws.close()
      ws = null
    }
    ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

    ws.onopen = () => {
      console.log('[WebSocket] 连接成功')
      startHeartbeat()
      resolve()
    }

    ws.onmessage = async (event) => {
      if (event.data === 'pong') return
      const msg = JSON.parse(event.data)
      if (msg.type === 'offer') {
        // 接收端接收offer
        if (!pc) createPeerConnection()
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))
      } else if (msg.type === 'answer') {
        // 发送端接收answer
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
      } else if (msg.type === 'candidate') {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } catch (e) {
          console.warn('添加 ICE Candidate 失败:', e)
        }
      } else if (msg.type === 'fileMeta') {
        // 接收端收到文件元信息，准备接收
        isReceiver.value = true
        fileName.value = msg.name
        sliceSize = msg.sliceSize
        totalSlices = msg.totalSlices
        receivedCount = 0
        receivedBuffers = new Array(totalSlices)
        downloadProgress.value = 0
        downloadReady.value = false
      }
    }

    ws.onclose = () => {
      console.warn('[WebSocket] 断开，3秒后重连')
      stopHeartbeat()
      setTimeout(() => setupWebSocket(), 3000)
    }

    ws.onerror = (err) => {
      console.error('[WebSocket] 错误:', err)
      ws.close()
    }
  })
}

let heartbeatTimer = null
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping')
  }, 20000)
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
}

// 创建RTCPeerConnection和DataChannels
function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:59.110.35.198:3478' }]
  })

  pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
  }

  if (isReceiver.value) {
    // 接收端监听datachannel
    pc.ondatachannel = (e) => {
      const channel = e.channel
      channel.binaryType = 'arraybuffer'
      console.log('[DataChannel] 新通道', channel.label)
      setupReceiveChannel(channel)
    }
  } else {
    // 发送端创建多个DataChannel
    dataChannels = []
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const channel = pc.createDataChannel(`ch-${i}`, { ordered: true, reliable: true })
      channel.binaryType = 'arraybuffer'
      dataChannels.push(channel)
    }
  }
}

// 发送端开始传输
async function startTransfer() {
  if (!file.value) return alert('请先选择文件')
  sending.value = true
  await setupWebSocket()
  createPeerConnection()

  // 创建offer并发送
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer }))

  // 等待所有DataChannel打开
  await waitAllChannelsOpen(dataChannels)

  console.log('🟢 所有DataChannel已打开，开始并行传输文件')
  sendFileParallel()
}

function waitAllChannelsOpen(channels) {
  return Promise.all(
    channels.map(
      (ch) =>
        new Promise((resolve) => {
          if (ch.readyState === 'open') resolve()
          else ch.onopen = () => resolve()
          ch.onerror = (e) => console.error('[DataChannel] 错误', e)
        })
    )
  )
}

// 并行分片发送
async function sendFileParallel() {
  const f = file.value
  const total = Math.ceil(f.size / SLICE_SIZE)

  ws.send(
    JSON.stringify({
      type: 'fileMeta',
      name: f.name,
      size: f.size,
      sliceSize: SLICE_SIZE,
      totalSlices: total,
      channelCount: dataChannels.length
    })
  )

  let sent = 0

  for (let i = 0; i < total; i++) {
    const start = i * SLICE_SIZE
    const end = Math.min(f.size, start + SLICE_SIZE)
    const blob = f.slice(start, end)
    const buffer = await blob.arrayBuffer()

    // 4字节序号头 + 数据体
    const header = new Uint32Array([i])
    const payload = new Uint8Array(header.byteLength + buffer.byteLength)
    payload.set(new Uint8Array(header.buffer), 0)
    payload.set(new Uint8Array(buffer), header.byteLength)

    // 轮询选通道发
    const ch = dataChannels[i % dataChannels.length]

    if (ch.readyState === 'open') {
      ch.send(payload)
    } else {
      console.warn(`[WARN] 通道 ${ch.label} 不是open，跳过片段 ${i}`)
    }

    sent++
    progress.value = ((sent / total) * 100).toFixed(2)
    await sleep(1) // 给事件循环喘息，防止堵塞（可根据网络调整）
  }

  sending.value = false
  console.log('✅ 文件发送完毕')
}

// 接收端处理单个DataChannel
function setupReceiveChannel(channel) {
  channel.onmessage = async (event) => {
    const buf = event.data
    const view = new DataView(buf)
    const idx = view.getUint32(0, false)
    const data = buf.slice(4)

    if (!receivedBuffers[idx]) {
      receivedBuffers[idx] = data
      receivedCount++
      downloadProgress.value = ((receivedCount / totalSlices) * 100).toFixed(2)
    }

    if (receivedCount === totalSlices) {
      console.log('✅ 文件接收完成')
      downloadReady.value = true
      // 合并文件buffer
      createDownloadBlob()
    }
  }
}

let downloadBlob = null
function createDownloadBlob() {
  // 拼接ArrayBuffer数组
  const buffers = receivedBuffers.filter(Boolean)
  if (buffers.length !== totalSlices) {
    console.error('接收片段不完整')
    return
  }
  downloadBlob = new Blob(buffers)
}

// 下载按钮触发
function downloadFile() {
  if (!downloadBlob) return alert('文件还没准备好')
  const url = URL.createObjectURL(downloadBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName.value
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// 工具
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

onMounted(() => {
  // 这里可根据需求设置角色，比如URL带 ?receiver=true
  const urlParams = new URLSearchParams(window.location.search)
  if (urlParams.get('receiver') === 'true') {
    isReceiver.value = true
    setupWebSocket().then(() => {
      createPeerConnection()
    })
  }
})
</script>

<style>
#app {
  max-width: 600px;
  margin: 20px auto;
  font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
}
progress {
  width: 100%;
  height: 20px;
}
button {
  margin-top: 10px;
  padding: 6px 12px;
  font-size: 16px;
}
</style>
