<template>
  <div id="app">
    <h1>高速传输</h1>

    <input type="file" @change="onFileChange" />
    <button @click="startTransfer" :disabled="!file || isSending">开始传输</button>

    <div v-if="file">
      <p>文件名: {{ file.name }}</p>
      <p>发送进度: {{ progress }}%</p>
      <progress :value="progress" max="100"></progress>
    </div>

    <div v-if="receiving || downloadUrl">
      <p>接收文件: <span>{{ fileName }}</span></p>
      <p>接收进度: {{ downloadProgress }}%</p>
      <progress :value="downloadProgress" max="100"></progress>

      <div v-if="downloadUrl">
        <p><a :href="downloadUrl" :download="fileName">点击下载 {{ fileName }}</a></p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const receiving = ref(false)       // 是否正在接收
const file = ref(null)             // 选中文件
const progress = ref(0)            // 发送进度
const downloadUrl = ref('')        // 接收端文件下载链接
const fileName = ref('')           // 接收端文件名
const downloadProgress = ref(0)    // 接收进度
const isSending = ref(false)       // 是否正在发送，防止重复点

let ws = null
let pc = null
let dataChannel = null

let heartbeatTimer = null
let reconnectTimer = null

let offset = 0
const chunkSize = 128 * 1024
const reader = new FileReader()

function onFileChange(e) {
  file.value = e.target.files[0]
  progress.value = 0
  downloadUrl.value = ''
  downloadProgress.value = 0
  fileName.value = ''
}

async function startTransfer() {
  if (!file.value) return
  isSending.value = true
  progress.value = 0

  if (!ws || ws.readyState >= WebSocket.CLOSING) {
    await setupWebSocket()
  }

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:59.110.35.198:3478' }]
  })

  dataChannel = pc.createDataChannel('fileTransfer', {
    ordered: true,
    reliable: true
  })

  dataChannel.binaryType = 'arraybuffer'
  dataChannel.bufferedAmountLowThreshold = 256 * 1024

  dataChannel.onopen = () => {
    console.log('[WebRTC] DataChannel打开，开始传输')
    sendFile(file.value)
  }

  dataChannel.onbufferedamountlow = () => {
    sendNextSlice()
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  ws.send(JSON.stringify({ type: 'offer', offer }))
}

function waitForSocketOpen(socket) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve()
    } else {
      socket.onopen = () => resolve()
      socket.onerror = (err) => reject(err)
    }
  })
}

async function setupWebSocket() {
  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  ws = new WebSocket('ws://59.110.35.198/call-api/ws/file')

  ws.onopen = () => {
    console.log('[WebSocket] 已连接')
    startHeartbeat()
  }

  ws.onclose = () => {
    console.warn('[WebSocket] 断开，重连中...')
    stopHeartbeat()
    reconnectTimer = setTimeout(() => {
      setupWebSocket()
    }, 3000)
  }

  ws.onerror = (err) => {
    console.error('[WebSocket] 错误:', err)
    ws.close()
  }

  ws.onmessage = async (event) => {
    if (event.data === 'pong') {
      // 心跳回复
      return
    }

    let msg = null
    try {
      msg = JSON.parse(event.data)
    } catch (e) {
      console.error('消息解析失败', e)
      return
    }

    if (msg.type === 'offer') {
      console.log('[WebRTC] 收到offer，准备回应')

      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:59.110.35.198:3478' }]
      })

      pc.ondatachannel = (event) => {
        console.log('[WebRTC] 收到DataChannel')
        receiveFile(event.channel)
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
        }
      }

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      ws.send(JSON.stringify({ type: 'answer', answer }))
    }

    if (msg.type === 'answer') {
      console.log('[WebRTC] 收到answer')
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
    }

    if (msg.type === 'candidate') {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      } catch (e) {
        console.error('ICE candidate错误:', e)
      }
    }
  }

  await waitForSocketOpen(ws)
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
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

let receivedBuffers = []
let expectedSize = 0

function receiveFile(channel) {
  receivedBuffers = []
  expectedSize = 0
  fileName.value = ''
  downloadProgress.value = 0
  receiving.value = true

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data)
      if (msg.type === 'fileInfo') {
        expectedSize = msg.fileSize
        fileName.value = msg.fileName
      } else if (msg.type === 'done') {
        const blob = new Blob(receivedBuffers)
        downloadUrl.value = URL.createObjectURL(blob)
        receiving.value = false
      }
    } else {
      receivedBuffers.push(event.data)
      let receivedBytes = receivedBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      downloadProgress.value = Number(((receivedBytes / expectedSize) * 100).toFixed(2))
    }
  }
}

function sendFile(selectedFile) {
  offset = 0
  progress.value = 0

  // 先发文件信息
  if (dataChannel.readyState !== 'open') {
    console.warn('[WebRTC] DataChannel未打开，无法发送文件信息')
    return
  }
  dataChannel.send(
    JSON.stringify({
      type: 'fileInfo',
      fileName: selectedFile.name,
      fileSize: selectedFile.size
    })
  )
  sendNextSlice()
}

function sendNextSlice() {
  if (!file.value) return
  if (offset >= file.value.size) {
    if (dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'done' }))
      console.log('[WebRTC] 文件传输完成')
      isSending.value = false
    }
    return
  }

  if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
    // 等待缓冲区降低事件触发
    return
  }

  const slice = file.value.slice(offset, offset + chunkSize)
  reader.readAsArrayBuffer(slice)
}

reader.onload = (e) => {
  if (dataChannel && dataChannel.readyState === 'open') {
    dataChannel.send(e.target.result)
    offset += e.target.result.byteLength
    progress.value = Number(((offset / file.value.size) * 100).toFixed(2))
    sendNextSlice()
  }
}

onMounted(() => {
  setupWebSocket()
})

onBeforeUnmount(() => {
  stopHeartbeat()
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (ws) ws.close()
  if (pc) pc.close()
})
</script>

<style>
#app {
  max-width: 600px;
  margin: 2rem auto;
  font-family: Arial, sans-serif;
}

progress {
  width: 100%;
  height: 20px;
}
</style>

