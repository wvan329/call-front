<template>
  <div id="app">
    <h1>大文件传输12</h1>

    <input type="file" @change="onFileChange" />
    <button @click="startTransfer" :disabled="!file || sending">开始传输</button>

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

const file = ref(null)
const progress = ref(0)
const downloadProgress = ref(0)
const fileName = ref('')
const downloadUrl = ref('')
const sending = ref(false)
const receiving = ref(false)

let ws = null
let pc = null
let dataChannel = null

let totalSize = 0
let sentBytes = 0

// 初始化WebSocket和监听
function setupWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }
  ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

  ws.onopen = () => {
    console.log('[WebSocket] 已连接')
    startHeartbeat()
  }

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'offer') {
      console.log('[WebRTC] 收到offer')
      if (pc) pc.close()
      pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
        }
      }

      pc.ondatachannel = (e) => {
        console.log('[WebRTC] 接收到数据通道')
        receiving.value = true
        receiveFile(e.channel)
      }

      await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      ws.send(JSON.stringify({ type: 'answer', answer }))
    } else if (msg.type === 'answer') {
      console.log('[WebRTC] 收到answer')
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
    } else if (msg.type === 'candidate') {
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } catch (e) {
          console.warn('[WebRTC] candidate错误', e)
        }
      }
    } else if (event.data === 'pong') {
      // 心跳响应
    }
  }

  ws.onclose = () => {
    console.warn('[WebSocket] 断开，重连中...')
    stopHeartbeat()
    setTimeout(() => {
      setupWebSocket()
    }, 3000)
  }

  ws.onerror = (e) => {
    console.error('[WebSocket] 错误', e)
    ws.close()
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('ping')
    }
  }, 10000)
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

let heartbeatTimer = null

const onFileChange = (e) => {
  file.value = e.target.files[0]
  progress.value = 0
  downloadProgress.value = 0
  downloadUrl.value = ''
  fileName.value = ''
}

async function startTransfer() {
  if (!file.value) return

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('WebSocket尚未连接，等待连接...')
    await waitForSocketOpen()
  }

  sending.value = true
  totalSize = file.value.size
  sentBytes = 0
  progress.value = 0

  if (pc) pc.close()
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
    }
  }

  dataChannel = pc.createDataChannel('fileTransfer', { ordered: true, reliable: true })
  dataChannel.binaryType = 'arraybuffer'

  dataChannel.onopen = () => {
    console.log('[DataChannel] 通道打开，开始发送文件')
    sendFile(file.value)
  }
  dataChannel.onerror = (e) => {
    console.error('[DataChannel] 错误', e)
  }
  dataChannel.onclose = () => {
    console.log('[DataChannel] 关闭')
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer: pc.localDescription }))
}

function sendFile(file) {
  const chunkSize = 64 * 1024
  let offset = 0

  dataChannel.send(JSON.stringify({ type: 'fileInfo', fileName: file.name, fileSize: file.size }))

  const reader = new FileReader()

  reader.onload = (e) => {
    dataChannel.send(e.target.result)
    offset += e.target.result.byteLength
    sentBytes += e.target.result.byteLength
    progress.value = ((sentBytes / totalSize) * 100).toFixed(2)

    if (offset < file.size) {
      if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
        dataChannel.onbufferedamountlow = () => {
          dataChannel.onbufferedamountlow = null
          sendNextChunk()
        }
      } else {
        sendNextChunk()
      }
    } else {
      dataChannel.send(JSON.stringify({ type: 'done' }))
      sending.value = false
      console.log('[发送完成]')
    }
  }

  function sendNextChunk() {
    const slice = file.slice(offset, offset + chunkSize)
    reader.readAsArrayBuffer(slice)
  }

  sendNextChunk()
}

function receiveFile(channel) {
  let buffers = []
  let receivedBytes = 0
  let expectedSize = 0
  let name = ''

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data)
      if (msg.type === 'fileInfo') {
        expectedSize = msg.fileSize
        name = msg.fileName
        fileName.value = name
        receiving.value = true
      } else if (msg.type === 'done') {
        const blob = new Blob(buffers)
        downloadUrl.value = URL.createObjectURL(blob)
        receiving.value = false
        console.log('[接收完成]')
      }
    } else {
      buffers.push(event.data)
      receivedBytes += event.data.byteLength
      downloadProgress.value = ((receivedBytes / expectedSize) * 100).toFixed(2)
    }
  }
}

function waitForSocketOpen() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve()
    } else {
      if (!ws) setupWebSocket()
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    }
  })
}

onMounted(() => {
  setupWebSocket()
})
onBeforeUnmount(() => {
  stopHeartbeat()
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
