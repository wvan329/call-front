<template>
  <div id="app">
    <h1>大文件传输</h1>

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

const receiving = ref(false)
const sending = ref(false)
const file = ref(null)
const progress = ref(0)
const downloadUrl = ref('')
const fileName = ref('')
const downloadProgress = ref(0)

let ws = null
let pc = null
let dataChannels = []  // 多通道并行传输
let maxChannels = 4     // 并行通道数，可调
let chunkSize = 64 * 1024

let heartbeatTimer = null
let reconnectTimer = null

let totalSize = 0
let sentBytes = 0

// 断开时清理
onBeforeUnmount(() => {
  cleanup()
})

function cleanup() {
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  if (pc) {
    pc.close()
    pc = null
  }
  dataChannels = []
  sending.value = false
  receiving.value = false
  progress.value = 0
  downloadProgress.value = 0
  downloadUrl.value = ''
  fileName.value = ''
}

function setupWebSocket() {
  if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
    return // 已经连接中
  }

  ws = new WebSocket('ws://59.110.35.198/wgk/ws/file')

  ws.onopen = () => {
    console.log('[WebSocket] 已连接')
    startHeartbeat()
  }

  ws.onclose = () => {
    console.warn('[WebSocket] 已断开，尝试重连...')
    stopHeartbeat()
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      setupWebSocket()
    }, 3000)
  }

  ws.onerror = (err) => {
    console.error('[WebSocket] 错误:', err)
    ws.close()
  }

  ws.onmessage = async (event) => {
    // console.log('[WebSocket] 收到消息:', event.data)
    try {
      const msg = JSON.parse(event.data)

      if (msg.type === 'offer') {
        console.log('[WebRTC] 收到 offer')
        if (pc) {
          pc.close()
          pc = null
        }
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

        pc.onicecandidate = (event) => {
          if (event.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
          }
        }

        pc.ondatachannel = (event) => {
          console.log('[WebRTC] 接收通道打开')
          receiving.value = true
          receiveFile(event.channel)
        }

        await pc.setRemoteDescription(new RTCSessionDescription(msg.offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        ws.send(JSON.stringify({ type: 'answer', answer }))
      } else if (msg.type === 'answer') {
        console.log('[WebRTC] 收到 answer')
        await pc.setRemoteDescription(new RTCSessionDescription(msg.answer))
      } else if (msg.type === 'candidate') {
        // console.log('[WebRTC] 收到 candidate')
        if (pc) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
          } catch (e) {
            console.warn('[WebRTC] ICE candidate 添加失败', e)
          }
        }
      }
    } catch (e) {
      if (event.data === 'pong') {
        // 心跳回应
        // console.log('[WebSocket] 收到 pong')
      } else {
        console.warn('[WebSocket] 无法解析消息:', event.data)
      }
    }
  }
}

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('ping')
    }
  }, 10000) // 10秒心跳
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

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
    console.log('[WebSocket] 连接尚未准备好，等待连接...')
    await waitForSocketOpen()
  }

  sending.value = true
  totalSize = file.value.size
  sentBytes = 0
  progress.value = 0

  if (pc) {
    pc.close()
    pc = null
  }
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

  pc.onicecandidate = (event) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }))
    }
  }

  dataChannels = []

  // 创建多个datachannel实现并行传输
  for (let i = 0; i < maxChannels; i++) {
    const dc = pc.createDataChannel(`fileTransfer${i}`, { ordered: true, reliable: true })
    dc.binaryType = 'arraybuffer'
    dc.bufferedAmountLowThreshold = 256 * 1024
    dataChannels.push(dc)
  }

  // 等待所有 dataChannel 都 open，再开始传输
  await new Promise((resolve) => {
    let openedCount = 0
    dataChannels.forEach((dc) => {
      dc.onopen = () => {
        openedCount++
        if (openedCount === maxChannels) resolve()
      }
      dc.onclose = () => {
        console.log('[DataChannel] 关闭:', dc.label)
      }
      dc.onerror = (e) => {
        console.error('[DataChannel] 错误:', e)
      }
    })
  })

  // 发送文件信息到所有通道（任选一个即可）
  dataChannels[0].send(JSON.stringify({
    type: 'fileInfo',
    fileName: file.value.name,
    fileSize: totalSize,
    chunkSize,
    maxChannels
  }))

  // 创建 offer，发送信令
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  ws.send(JSON.stringify({ type: 'offer', offer }))

  // 分片并行发送
  parallelSendFile(file.value)
}

// 并行发送文件分块
function parallelSendFile(file) {
  const totalChunks = Math.ceil(file.size / chunkSize)
  let offsetList = []
  for (let i = 0; i < maxChannels; i++) {
    offsetList.push(i) // 每个通道初始负责第i个chunk及之后每隔maxChannels的chunk
  }

  let finishedCount = 0
  const channelStatus = new Array(maxChannels).fill(true) // 是否可以继续发送

  function sendChunk(channelIndex, chunkIndex) {
    if (chunkIndex >= totalChunks) {
      finishedCount++
      if (finishedCount === maxChannels) {
        // 发送结束
        dataChannels.forEach(dc => dc.send(JSON.stringify({ type: 'done' })))
        sending.value = false
        console.log('[发送完成]')
      }
      return
    }

    const dc = dataChannels[channelIndex]
    if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = null
        sendChunk(channelIndex, chunkIndex)
      }
      return
    }

    const start = chunkIndex * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const slice = file.slice(start, end)

    const reader = new FileReader()
    reader.onload = (e) => {
      dc.send(e.target.result)
      sentBytes += (end - start)
      progress.value = ((sentBytes / totalSize) * 100).toFixed(2)

      sendChunk(channelIndex, chunkIndex + maxChannels)
    }
    reader.readAsArrayBuffer(slice)
  }

  // 启动每个通道的发送流程
  for (let i = 0; i < maxChannels; i++) {
    sendChunk(i, i)
  }
}

// 接收端接收文件
function receiveFile(channel) {
  let receivedBuffers = []
  let receivedBytes = 0
  let expectedSize = 0
  let name = ''
  let maxChannelsRecv = 1
  let chunkSizeRecv = 64 * 1024

  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data)
      if (msg.type === 'fileInfo') {
        expectedSize = msg.fileSize
        name = msg.fileName
        fileName.value = name
        receiving.value = true
        chunkSizeRecv = msg.chunkSize || chunkSizeRecv
        maxChannelsRecv = msg.maxChannels || 1
        // 初始化多通道接收数组
        receiveBuffers.length = maxChannelsRecv
        for(let i=0; i<maxChannelsRecv; i++) {
          receiveBuffers[i] = []
          receiveReceivedBytes[i] = 0
        }
      } else if (msg.type === 'done') {
        // 合并所有缓冲区
        const allBuffers = []
        for (let bufArr of receiveBuffers) {
          allBuffers.push(...bufArr)
        }
        const blob = new Blob(allBuffers)
        downloadUrl.value = URL.createObjectURL(blob)
        receiving.value = false
        console.log('[接收完成]')
      }
    } else {
      // 二进制数据，保存到对应缓冲
      receiveBuffers[currentChannelIndex].push(event.data)
      receiveReceivedBytes[currentChannelIndex] += event.data.byteLength
      receivedBytes += event.data.byteLength
      downloadProgress.value = ((receivedBytes / expectedSize) * 100).toFixed(2)
    }
  }
}

// --- receiveFile 需要知道当前是哪个通道，所以下面重写 pc.ondatachannel

const receiveBuffers = []
const receiveReceivedBytes = []
let currentChannelIndex = 0

onMounted(() => {
  setupWebSocket()

  // 监听接收数据通道，更新currentChannelIndex并调用receiveFile
  if (!pc) {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:59.110.35.198:3478' }] })

    pc.ondatachannel = (event) => {
      console.log('[WebRTC] 接收端通道:', event.channel.label)
      currentChannelIndex = parseInt(event.channel.label.replace('fileTransfer', '')) || 0
      receiveFile(event.channel)
    }
  }
})

function waitForSocketOpen() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      resolve()
    } else {
      if (!ws) {
        setupWebSocket()
      }
      ws.onopen = () => resolve()
      ws.onerror = (e) => reject(e)
    }
  })
}

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
