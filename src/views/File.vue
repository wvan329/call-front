<template>
  <div id="app">
    <h1>大文件并行传输加速测试12</h1>

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
const downloadUrl = ref('')
const fileName = ref('')
const downloadProgress = ref(0)
const receiving = ref(false)
const sending = ref(false)

let ws = null
let pc = null
let dataChannels = []
let heartbeatTimer = null
let reconnectTimer = null

const NUM_CHANNELS = 4
const CHUNK_SIZE = 64 * 1024

const onFileChange = (e) => {
  file.value = e.target.files[0]
  progress.value = 0
  sending.value = false
  downloadUrl.value = ''
  downloadProgress.value = 0
  fileName.value = ''
  receiving.value = false
  console.log('选择文件:', file.value.name)
}

const setupWebSocket = () => {
  if (ws) {
    ws.close()
  }
  clearReconnectTimer()

  ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

  ws.onopen = () => {
    console.log('[WebSocket] 已连接')
    startHeartbeat()
  }

  ws.onclose = () => {
    console.warn('[WebSocket] 断开，尝试重连...')
    stopHeartbeat()
    clearReconnectTimer()
    reconnectTimer = setTimeout(() => {
      setupWebSocket()
    }, 3000)
  }

  ws.onerror = (err) => {
    console.error('[WebSocket] 错误:', err)
    ws.close()
  }

  ws.onmessage = async (event) => {
    if (!pc) return

    try {
      const msg = JSON.parse(event.data)

      if (msg.type === 'offer') {
        console.log('[WebSocket] 收到offer')
        pc = createPeerConnection()
        pc.ondatachannel = (e) => receiveFile(e.channel)
        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))
        console.log('[WebSocket] 发送answer')
      } else if (msg.type === 'answer') {
        console.log('[WebSocket] 收到answer')
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
      } else if (msg.type === 'candidate') {
        console.log('[WebSocket] 收到candidate')
        try {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
        } catch (e) {
          console.error('ICE candidate error:', e)
        }
      }
    } catch (e) {
      // 心跳ping/pong可能不是json，忽略
    }
  }
}

const clearReconnectTimer = () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

const startHeartbeat = () => {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('ping')
      console.log('[WebSocket] 发送ping')
    }
  }, 20000)
}

const stopHeartbeat = () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

const createPeerConnection = () => {
  const newPc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:59.110.35.198:3478' }]
  })

  newPc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
      console.log('[WebRTC] 发送candidate')
    }
  }

  return newPc
}

const waitForSocketOpen = (socket) => {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) resolve()
    else {
      socket.onopen = () => resolve()
      socket.onerror = (e) => reject(e)
    }
  })
}

const startTransfer = async () => {
  if (!file.value) {
    alert('请先选择文件')
    return
  }

  if (!ws || ws.readyState >= WebSocket.CLOSING) {
    setupWebSocket()
    await waitForSocketOpen(ws)
  }

  pc = createPeerConnection()
  dataChannels = []

  let openCount = 0

  for (let i = 0; i < NUM_CHANNELS; i++) {
    const dc = pc.createDataChannel(`fileTransfer${i}`, {
      ordered: true,
      reliable: true
    })
    dc.binaryType = 'arraybuffer'

    dc.onopen = () => {
      openCount++
      console.log(`DataChannel ${i} 打开`)
      if (openCount === NUM_CHANNELS) {
        console.log('所有DataChannel已打开，开始发送文件')
        sendFileParallel(file.value)
      }
    }

    dc.onclose = () => {
      console.log(`DataChannel ${i} 关闭`)
    }

    dataChannels.push(dc)
  }

  sending.value = true
  progress.value = 0

  pc.onicecandidate = (event) => {
    if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
      console.log('[WebRTC] 发送candidate')
    }
  }

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer }))
  console.log('[WebRTC] 发送offer')
}

const sendFileParallel = (file) => {
  const totalSize = file.size
  const chunkSize = CHUNK_SIZE
  const numChannels = dataChannels.length
  let offsets = new Array(numChannels).fill(0)
  let finishedChannels = 0
  let sentBytes = 0

  // 发送文件信息只通过第一个通道
  dataChannels[0].send(JSON.stringify({
    type: 'fileInfo',
    fileName: file.name,
    fileSize: totalSize,
    numChannels,
  }))

  for (let i = 0; i < numChannels; i++) {
    sendChunk(i)
  }

  function sendChunk(channelIndex) {
    if (offsets[channelIndex] >= totalSize) {
      dataChannels[channelIndex].send(JSON.stringify({ type: 'done', channelIndex }))
      finishedChannels++
      if (finishedChannels === numChannels) {
        sending.value = false
        console.log('所有通道发送完毕')
      }
      return
    }

    const start = offsets[channelIndex]
    const slice = file.slice(start, start + chunkSize)
    const reader = new FileReader()

    reader.onload = (e) => {
      dataChannels[channelIndex].send(e.target.result)
      offsets[channelIndex] += chunkSize
      sentBytes += e.target.result.byteLength
      progress.value = ((sentBytes / totalSize) * 100).toFixed(2)

      const dc = dataChannels[channelIndex]
      if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
        dc.onbufferedamountlow = () => {
          sendChunk(channelIndex)
          dc.onbufferedamountlow = null
        }
      } else {
        sendChunk(channelIndex)
      }
    }

    reader.readAsArrayBuffer(slice)
  }
}

const receiveFile = (channel) => {
  const idx = parseInt(channel.label.replace('fileTransfer', ''))
  if (isNaN(idx)) return

  if (!window._receivedBuffersMap) {
    window._receivedBuffersMap = {}
    window._receivedBytesMap = {}
    window._expectedSize = 0
    window._fileName = ''
    window._numChannels = 0
  }

  const receivedBuffersMap = window._receivedBuffersMap
  const receivedBytesMap = window._receivedBytesMap

  receivedBuffersMap[idx] = []
  receivedBytesMap[idx] = 0

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'fileInfo') {
          window._expectedSize = msg.fileSize
          window._fileName = msg.fileName
          window._numChannels = msg.numChannels
          fileName.value = msg.fileName
          receiving.value = true
          downloadProgress.value = 0
          console.log('收到文件信息:', msg)
        } else if (msg.type === 'done') {
          receivedBytesMap[idx] = -1

          if (Object.values(receivedBytesMap).length === window._numChannels &&
              Object.values(receivedBytesMap).every(val => val === -1)) {

            let buffers = []
            for (let i = 0; i < window._numChannels; i++) {
              buffers = buffers.concat(receivedBuffersMap[i])
            }

            const blob = new Blob(buffers)
            const url = URL.createObjectURL(blob)
            downloadUrl.value = url
            receiving.value = false
            console.log('文件接收完成')
          }
        }
      } catch (e) {
        console.error('接收消息解析错误', e)
      }
    } else {
      receivedBuffersMap[idx].push(event.data)
      receivedBytesMap[idx] += event.data.byteLength

      const totalReceived = Object.values(receivedBytesMap).reduce((acc, val) => val === -1 ? acc : acc + val, 0)
      if (window._expectedSize > 0) {
        downloadProgress.value = ((totalReceived / window._expectedSize) * 100).toFixed(2)
      }
    }
  }
}

onMounted(() => {
  setupWebSocket()
})

onBeforeUnmount(() => {
  stopHeartbeat()
  clearReconnectTimer()
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
