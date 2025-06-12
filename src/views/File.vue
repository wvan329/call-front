<template>
  <div id="app">
    <h1>大文件传输</h1>

    <input type="file" @change="onFileChange" />
    <button @click="startTransfer" :disabled="!file">开始传输</button>

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
import { ref, onMounted } from 'vue'
const receiving = ref(false) // 是否正在接收中
const file = ref(null)
const progress = ref(0)
const downloadUrl = ref('')
const fileName = ref('')
const downloadProgress = ref(0)

let ws
let pc
let dataChannel
let lastTime = Date.now()
let lastBytes = 0
let startTime = 0
let sentBytes = 0
let totalSize = 0

const onFileChange = (e) => {
  file.value = e.target.files[0]
}

const startTransfer = async () => {
  if (!ws || ws.readyState >= WebSocket.CLOSING) {
    ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')
    setupWebSocket()
    await waitForSocketOpen(ws)
  }

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:59.110.35.198:3478' }]
  })

  dataChannel = pc.createDataChannel('fileTransfer', {
    ordered: true,
    reliable: true
  })

  dataChannel.binaryType = 'arraybuffer'
  dataChannel.bufferedAmountLowThreshold = 128 * 1024

  dataChannel.onopen = () => {
    sendFile(file.value)
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

const waitForSocketOpen = (socket) => {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve()
    } else {
      socket.onopen = () => resolve()
      socket.onerror = (err) => reject(err)
    }
  })
}

function setupWebSocket() {
  ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data)

    if (msg.type === 'offer') {
      pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:59.110.35.198:3478' }]
      })

      pc.ondatachannel = (event) => {
        const receiveChannel = event.channel
        receiveFile(receiveChannel)
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
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
    }

    if (msg.type === 'candidate') {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
      } catch (e) {
        console.error('ICE candidate error:', e)
      }
    }
  }
}

function sendFile(file) {
  totalSize = file.size
  sentBytes = 0
  lastTime = Date.now()
  lastBytes = 0
  startTime = Date.now()

  dataChannel.send(
    JSON.stringify({
      type: 'fileInfo',
      fileName: file.name,
      fileSize: file.size
    })
  )

  const chunkSize = 64 * 1024
  let offset = 0

  const reader = new FileReader()

  reader.onload = (e) => {
    dataChannel.send(e.target.result)
    offset += e.target.result.byteLength
    sentBytes += e.target.result.byteLength
    lastBytes = sentBytes
    progress.value = ((sentBytes / totalSize) * 100).toFixed(2)

    if (offset < file.size) {
      if (dataChannel.bufferedAmount > dataChannel.bufferedAmountLowThreshold) {
        dataChannel.onbufferedamountlow = () => {
          sendNextSlice()
        }
      } else {
        sendNextSlice()
      }
    } else {
      dataChannel.send(JSON.stringify({ type: 'done' }))
    }
  }

  const sendNextSlice = () => {
    const slice = file.slice(offset, offset + chunkSize)
    reader.readAsArrayBuffer(slice)
  }

  sendNextSlice()
}

function receiveFile(channel) {
  let receivedBuffers = []
  let receivedBytes = 0
  let expectedSize = 0
  let name = ''
  let lastTimeRecv = Date.now()
  let lastBytesRecv = 0

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data)
      if (msg.type === 'fileInfo') {
        expectedSize = msg.fileSize
        name = msg.fileName
        fileName.value = name
        receiving.value = true // 立即显示 UI
      } else if (msg.type === 'done') {
        const blob = new Blob(receivedBuffers)
        const url = URL.createObjectURL(blob)
        downloadUrl.value = url
        receiving.value = false
      }
    } else {
      receivedBuffers.push(event.data)
      receivedBytes += event.data.byteLength
      downloadProgress.value = ((receivedBytes / expectedSize) * 100).toFixed(2)
    }
  }
}

onMounted(() => {
  setupWebSocket()
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
