<template>
  <div class="file-transfer-container">
    <h2>WebRTC 文件传输</h2>
    
    <div class="status">
      <span :class="connectionStatus">{{ connectionStatusText }}</span>
    </div>
    
    <div class="file-section">
      <h3>发送文件</h3>
      <input type="file" @change="handleFileSelect" ref="fileInput" />
      <button @click="startTransfer" :disabled="!selectedFile || !isConnected">
        {{ isSending ? '发送中...' : '发送文件' }}
      </button>
      <div v-if="selectedFile" class="file-info">
        {{ selectedFile.name }} ({{ formatSize(selectedFile.size) }})
      </div>
      <div class="progress" v-if="isSending">
        <div class="progress-bar" :style="{ width: progress + '%' }"></div>
        <span class="progress-text">{{ progress.toFixed(1) }}%</span>
        <span class="speed">{{ formatSpeed(speed) }}/s</span>
      </div>
    </div>
    
    <div class="file-section">
      <h3>接收文件</h3>
      <div v-if="receivedFile" class="file-info">
        {{ receivedFile.name }} ({{ formatSize(receivedFile.size) }})
        <a v-if="receivedFile.progress === 100" :href="receivedFile.url" :download="receivedFile.name" class="download">
          下载
        </a>
      </div>
      <div class="progress" v-if="isReceiving">
        <div class="progress-bar" :style="{ width: receivedFile.progress + '%' }"></div>
        <span class="progress-text">{{ receivedFile.progress.toFixed(1) }}%</span>
      </div>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { sha256 } from 'js-sha256'

// 配置
const WS_URL = 'ws://59.110.35.198/wgk/ws/file'
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }]
const CHUNK_SIZE = 64 * 1024 // 64KB 块大小 (经过测试的最佳平衡点)
const BUFFER_LIMIT = 8 * 1024 * 1024 // 8MB 发送缓冲区
const ACK_TIMEOUT = 3000 // 3秒ACK超时
const MAX_RETRIES = 10 // 最大重试次数

// 状态
const ws = ref(null)
const peerConnection = ref(null)
const dataChannel = ref(null)
const selectedFile = ref(null)
const isSending = ref(false)
const isReceiving = ref(false)
const progress = ref(0)
const speed = ref(0)
const error = ref('')
const receivedFile = ref(null)
const lastBytesSent = ref(0)
const lastSpeedTime = ref(0)
const peerId = ref('')
const myId = ref('')

// 计算属性
const isConnected = computed(() => peerConnection.value?.iceConnectionState === 'connected')
const connectionStatus = computed(() => isConnected.value ? 'connected' : 'disconnected')
const connectionStatusText = computed(() => 
  isConnected.value ? '已连接' : '未连接'
)

// 工具函数
const formatSize = (bytes) => {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const formatSpeed = (bytes) => {
  return formatSize(bytes).replace(' ', '')
}

// 文件处理
const handleFileSelect = (e) => {
  selectedFile.value = e.target.files[0]
  error.value = ''
}

const startTransfer = async () => {
  if (!selectedFile.value || !isConnected.value) return
  
  isSending.value = true
  progress.value = 0
  speed.value = 0
  lastBytesSent.value = 0
  lastSpeedTime.value = Date.now()
  error.value = ''
  
  try {
    const file = selectedFile.value
    const fileId = Date.now().toString()
    const fileSize = file.size
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE)
    const fileHash = await calculateFileHash(file)
    
    // 发送文件元数据
    sendMetadata(fileId, file.name, fileSize, file.type || 'application/octet-stream', fileHash)
    
    // 分块发送文件
    let offset = 0
    let chunkIndex = 0
    let pendingAcks = new Map()
    
    while (offset < fileSize && isConnected.value) {
      // 检查缓冲区
      if (dataChannel.value.bufferedAmount > BUFFER_LIMIT) {
        await new Promise(resolve => setTimeout(resolve, 50))
        continue
      }
      
      const chunk = file.slice(offset, offset + CHUNK_SIZE)
      const chunkData = await readFileChunk(chunk)
      
      // 发送数据包 [fileId(8B)][chunkIndex(4B)][data]
      const header = new ArrayBuffer(12)
      const headerView = new DataView(header)
      headerView.setBigUint64(0, BigInt(fileId), true)
      headerView.setUint32(8, chunkIndex, true)
      
      const packet = new Uint8Array(header.byteLength + chunkData.byteLength)
      packet.set(new Uint8Array(header), 0)
      packet.set(new Uint8Array(chunkData), header.byteLength)
      
      dataChannel.value.send(packet)
      
      // 记录等待ACK的块
      pendingAcks.set(chunkIndex, {
        timestamp: Date.now(),
        retries: 0,
        data: packet
      })
      
      // 更新进度
      offset += chunkData.byteLength
      chunkIndex++
      progress.value = (offset / fileSize) * 100
      
      // 计算速度
      const now = Date.now()
      if (now - lastSpeedTime.value > 500) {
        speed.value = (offset - lastBytesSent.value) / ((now - lastSpeedTime.value) / 1000)
        lastBytesSent.value = offset
        lastSpeedTime.value = now
      }
      
      // 处理ACK超时
      checkAcks(pendingAcks, totalChunks)
    }
    
    // 等待所有ACK
    while (pendingAcks.size > 0 && isConnected.value) {
      await new Promise(resolve => setTimeout(resolve, 100))
      checkAcks(pendingAcks, totalChunks)
    }
    
    if (pendingAcks.size > 0) {
      throw new Error('文件传输未完成')
    }
    
    // 发送完成消息
    sendCompletion(fileId)
    
  } catch (err) {
    error.value = '传输失败: ' + err.message
    console.error('传输错误:', err)
  } finally {
    isSending.value = false
  }
}

const checkAcks = (pendingAcks, totalChunks) => {
  const now = Date.now()
  for (const [index, ack] of pendingAcks.entries()) {
    if (now - ack.timestamp > ACK_TIMEOUT) {
      if (ack.retries < MAX_RETRIES) {
        // 重传
        dataChannel.value.send(ack.data)
        ack.retries++
        ack.timestamp = now
      } else {
        // 超过最大重试次数
        pendingAcks.delete(index)
        throw new Error(`块 ${index}/${totalChunks} 重传失败`)
      }
    }
  }
}

const sendMetadata = (fileId, name, size, type, hash) => {
  const metadata = {
    type: 'metadata',
    fileId,
    name,
    size,
    type,
    hash,
    chunkSize: CHUNK_SIZE,
    totalChunks: Math.ceil(size / CHUNK_SIZE)
  }
  dataChannel.value.send(JSON.stringify(metadata))
}

const sendCompletion = (fileId) => {
  const msg = { type: 'complete', fileId }
  dataChannel.value.send(JSON.stringify(msg))
}

const readFileChunk = (chunk) => {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.readAsArrayBuffer(chunk)
  })
}

const calculateFileHash = async (file) => {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      resolve(sha256(new Uint8Array(e.target.result)))
    }
    reader.readAsArrayBuffer(file)
  })
}

// WebSocket 连接
const connectWebSocket = () => {
  ws.value = new WebSocket(WS_URL)
  
  ws.value.onopen = () => {
    console.log('WebSocket已连接')
  }
  
  ws.value.onmessage = async (e) => {
    const msg = JSON.parse(e.data)
    
    switch (msg.type) {
      case 'session-id':
        myId.value = msg.id
        break
      case 'user-list':
        handleUserList(msg.users)
        break
      case 'offer':
        await handleOffer(msg.sdp, msg.from)
        break
      case 'answer':
        await handleAnswer(msg.sdp, msg.from)
        break
      case 'candidate':
        await handleCandidate(msg.candidate, msg.from)
        break
    }
  }
  
  ws.value.onclose = () => {
    console.log('WebSocket断开，尝试重连...')
    setTimeout(connectWebSocket, 3000)
  }
  
  ws.value.onerror = (err) => {
    console.error('WebSocket错误:', err)
  }
}

const sendWsMessage = (type, data) => {
  if (ws.value?.readyState === WebSocket.OPEN) {
    ws.value.send(JSON.stringify({ type, ...data }))
  }
}

// WebRTC 连接
const createPeerConnection = () => {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  peerConnection.value = pc
  
  pc.onicecandidate = (e) => {
    if (e.candidate && peerId.value) {
      sendWsMessage('candidate', { candidate: e.candidate, to: peerId.value })
    }
  }
  
  pc.oniceconnectionstatechange = () => {
    console.log('ICE状态:', pc.iceConnectionState)
  }
  
  // 创建数据通道 (仅发起方)
  if (!peerId.value) {
    const dc = pc.createDataChannel('fileTransfer', { ordered: true })
    setupDataChannel(dc)
  }
  
  pc.ondatachannel = (e) => {
    setupDataChannel(e.channel)
  }
}

const setupDataChannel = (dc) => {
  dataChannel.value = dc
  dc.binaryType = 'arraybuffer'
  
  dc.onopen = () => {
    console.log('数据通道已打开')
  }
  
  dc.onclose = () => {
    console.log('数据通道已关闭')
  }
  
  dc.onmessage = async (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data)
      handleDataMessage(msg)
    } else {
      await handleFileChunk(e.data)
    }
  }
}

const handleUserList = (users) => {
  const otherUsers = users.filter(id => id !== myId.value)
  if (otherUsers.length > 0) {
    peerId.value = otherUsers[0]
    createPeerConnection()
    createOffer()
  }
}

const createOffer = async () => {
  const offer = await peerConnection.value.createOffer()
  await peerConnection.value.setLocalDescription(offer)
  sendWsMessage('offer', { sdp: offer, to: peerId.value })
}

const handleOffer = async (sdp, from) => {
  peerId.value = from
  createPeerConnection()
  await peerConnection.value.setRemoteDescription(new RTCSessionDescription(sdp))
  const answer = await peerConnection.value.createAnswer()
  await peerConnection.value.setLocalDescription(answer)
  sendWsMessage('answer', { sdp: answer, to: from })
}

const handleAnswer = async (sdp, from) => {
  await peerConnection.value.setRemoteDescription(new RTCSessionDescription(sdp))
}

const handleCandidate = async (candidate, from) => {
  try {
    await peerConnection.value.addIceCandidate(new RTCIceCandidate(candidate))
  } catch (err) {
    console.error('添加ICE候选失败:', err)
  }
}

// 文件接收处理
const handleDataMessage = (msg) => {
  switch (msg.type) {
    case 'metadata':
      startReceivingFile(msg)
      break
    case 'ack':
      // 简化处理，实际应该记录已确认的块
      break
    case 'complete':
      completeFile(msg.fileId)
      break
  }
}

const startReceivingFile = (meta) => {
  receivedFile.value = {
    id: meta.fileId,
    name: meta.name,
    size: meta.size,
    type: meta.type,
    hash: meta.hash,
    chunks: new Map(),
    progress: 0,
    url: ''
  }
  isReceiving.value = true
}

const handleFileChunk = async (data) => {
  if (!receivedFile.value) return
  
  const view = new DataView(data)
  const fileId = view.getBigUint64(0, true).toString()
  const chunkIndex = view.getUint32(8, true)
  const chunkData = data.slice(12)
  
  // 存储块
  receivedFile.value.chunks.set(chunkIndex, chunkData)
  
  // 更新进度
  const received = receivedFile.value.chunks.size
  const total = Math.ceil(receivedFile.value.size / CHUNK_SIZE)
  receivedFile.value.progress = (received / total) * 100
  
  // 发送ACK
  dataChannel.value.send(JSON.stringify({
    type: 'ack',
    fileId,
    chunkIndex
  }))
  
  // 检查是否完成
  if (received === total) {
    completeFile(fileId)
  }
}

const completeFile = async (fileId) => {
  if (!receivedFile.value || receivedFile.value.id !== fileId) return
  
  try {
    // 按顺序组装文件
    const chunks = []
    for (let i = 0; i < receivedFile.value.chunks.size; i++) {
      chunks.push(receivedFile.value.chunks.get(i))
    }
    
    const blob = new Blob(chunks, { type: receivedFile.value.type })
    
    // 验证哈希
    if (receivedFile.value.hash) {
      const hash = await calculateFileHash(blob)
      if (hash !== receivedFile.value.hash) {
        throw new Error('文件校验失败')
      }
    }
    
    // 创建下载URL
    receivedFile.value.url = URL.createObjectURL(blob)
    receivedFile.value.progress = 100
    
  } catch (err) {
    error.value = '接收文件失败: ' + err.message
    console.error('文件组装错误:', err)
  } finally {
    isReceiving.value = false
  }
}

// 生命周期
onMounted(() => {
  connectWebSocket()
})

onUnmounted(() => {
  ws.value?.close()
  peerConnection.value?.close()
  if (receivedFile.value?.url) {
    URL.revokeObjectURL(receivedFile.value.url)
  }
})
</script>

<style scoped>
.file-transfer-container {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
  font-family: Arial, sans-serif;
}

.status {
  margin-bottom: 20px;
  padding: 10px;
  border-radius: 5px;
  text-align: center;
  font-weight: bold;
}

.connected {
  background-color: #d4edda;
  color: #155724;
}

.disconnected {
  background-color: #f8d7da;
  color: #721c24;
}

.file-section {
  margin-bottom: 30px;
  padding: 15px;
  border: 1px solid #ddd;
  border-radius: 8px;
}

input[type="file"] {
  display: block;
  margin: 10px 0;
  width: 100%;
}

button {
  background-color: #007bff;
  color: white;
  padding: 10px 15px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  width: 100%;
}

button:disabled {
  background-color: #6c757d;
  cursor: not-allowed;
}

.file-info {
  margin: 10px 0;
  padding: 10px;
  background-color: #f8f9fa;
  border-radius: 4px;
  display: flex;
  justify-content: space-between;
}

.download {
  color: white;
  background-color: #28a745;
  padding: 5px 10px;
  border-radius: 3px;
  text-decoration: none;
}

.progress {
  height: 20px;
  background-color: #e9ecef;
  border-radius: 10px;
  margin: 10px 0;
  position: relative;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background-color: #17a2b8;
  transition: width 0.3s;
}

.progress-text {
  position: absolute;
  left: 10px;
  top: 0;
  line-height: 20px;
  color: white;
  text-shadow: 0 0 2px #000;
}

.speed {
  position: absolute;
  right: 10px;
  top: 0;
  line-height: 20px;
  color: white;
  text-shadow: 0 0 2px #000;
}

.error {
  color: #dc3545;
  margin: 10px 0;
}
</style>