<script setup>
import { ref, reactive, onMounted } from 'vue'

const WS_URL = 'ws://59.110.35.198/wgk/ws/file'
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }]

const ws = ref(null)
const selfId = ref('')
const onlineUsers = ref([])

// peers存储结构:
// peers = {
//   [userId]: {
//     pc: RTCPeerConnection,
//     dc: RTCDataChannel (发送端),
//     pendingCandidates: [],
//     sendProgress: 0,       // 发送进度（百分比）
//     receiveProgress: 0,    // 接收进度（百分比）
//     receivedChunks: [],    // 接收缓存块
//     filename: '',          // 接收文件名
//     filesize: 0,           // 接收文件大小
//   }
// }
const peers = reactive({})

const file = ref(null)
const receivedFiles = ref([]) // { name, url, size, from }

// 监听文件选择
function handleFileChange(e) {
  file.value = e.target.files[0]
}

onMounted(() => {
  ws.value = new WebSocket(WS_URL)

  ws.value.onmessage = async (e) => {
    const msg = JSON.parse(e.data)
    switch (msg.type) {
      case 'session-id':
        selfId.value = msg.id
        break
      case 'user-list':
        onlineUsers.value = msg.users.filter(id => id !== selfId.value)
        break
      case 'offer':
        await handleOffer(msg)
        break
      case 'answer':
        if (peers[msg.from]) {
          await peers[msg.from].pc.setRemoteDescription(new RTCSessionDescription(msg.desc))
          // 处理早到的候选
          for (const c of peers[msg.from].pendingCandidates) {
            await peers[msg.from].pc.addIceCandidate(c)
          }
          peers[msg.from].pendingCandidates = []
        }
        break
      case 'candidate':
        if (peers[msg.from]) {
          if (peers[msg.from].pc.remoteDescription) {
            await peers[msg.from].pc.addIceCandidate(msg.candidate)
          } else {
            peers[msg.from].pendingCandidates.push(msg.candidate)
          }
        }
        break
      default:
        break
    }
  }
})

async function handleOffer(msg) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  peers[msg.from] = {
    pc,
    dc: null,
    pendingCandidates: [],
    sendProgress: 0,
    receiveProgress: 0,
    receivedChunks: [],
    filename: '',
    filesize: 0,
  }

  pc.ondatachannel = (e) => {
    setupReceiverDataChannel(msg.from, e.channel)
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.value.send(JSON.stringify({ type: 'candidate', to: msg.from, candidate }))
    }
  }

  await pc.setRemoteDescription(new RTCSessionDescription(msg.desc))

  // 处理早到的候选
  for (const c of peers[msg.from].pendingCandidates) {
    await pc.addIceCandidate(c)
  }
  peers[msg.from].pendingCandidates = []

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  ws.value.send(JSON.stringify({
    type: 'answer',
    to: msg.from,
    desc: pc.localDescription
  }))
}

function setupReceiverDataChannel(userId, dc) {
  const peer = peers[userId]
  if (!peer) return

  peer.dc = dc
  peer.receivedChunks = []
  peer.receiveProgress = 0
  peer.filename = ''
  peer.filesize = 0

  dc.onmessage = (e) => {
    // 接收到字符串，可能是元信息或EOF
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'meta' && msg.filename && msg.size) {
          peer.filename = msg.filename
          peer.filesize = msg.size
          peer.receiveProgress = 0
          peer.receivedChunks = []
          return
        }
      } catch {
        if (e.data === 'EOF') {
          const blob = new Blob(peer.receivedChunks)
          const url = URL.createObjectURL(blob)
          receivedFiles.value.push({
            name: peer.filename || ('file_' + Date.now()),
            url,
            size: blob.size,
            from: userId
          })
          peer.receiveProgress = 100
          // 清理缓存
          peer.receivedChunks = []
        }
        return
      }
    } else {
      peer.receivedChunks.push(e.data)
      const receivedSize = peer.receivedChunks.reduce((acc, chunk) => acc + (chunk.byteLength || chunk.length), 0)
      if (peer.filesize > 0) {
        peer.receiveProgress = Math.min(100, Math.floor((receivedSize / peer.filesize) * 100))
      }
    }
  }
}

async function sendFile() {
  if (!file.value) return
  if (onlineUsers.value.length === 0) {
    alert('当前没有在线用户！')
    return
  }

  for (const userId of onlineUsers.value) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const dc = pc.createDataChannel('file')
    peers[userId] = {
      pc,
      dc,
      pendingCandidates: [],
      sendProgress: 0,
      receiveProgress: 0,
      receivedChunks: [],
      filename: '',
      filesize: 0,
    }

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        ws.value.send(JSON.stringify({ type: 'candidate', to: userId, candidate }))
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    ws.value.send(JSON.stringify({
      type: 'offer',
      to: userId,
      desc: pc.localDescription
    }))

    const MAX_BUFFER = 16 * 1024 * 1024

    dc.onopen = async () => {
      // 先发元信息
      dc.send(JSON.stringify({ type: 'meta', filename: file.value.name, size: file.value.size }))

      const reader = file.value.stream().getReader()
      let sentSize = 0
      let { value, done } = await reader.read()

      while (!done) {
        // 等待缓冲区空闲
        while (dc.bufferedAmount > MAX_BUFFER) {
          await new Promise(res => setTimeout(res, 10))
        }

        if (dc.readyState !== 'open') {
          console.warn('DataChannel closed, 停止发送')
          break
        }

        dc.send(value)
        sentSize += value.byteLength || value.length
        peers[userId].sendProgress = Math.min(100, Math.floor((sentSize / file.value.size) * 100))

        ;({ value, done } = await reader.read())
      }

      if (dc.readyState === 'open') {
        dc.send('EOF')
        peers[userId].sendProgress = 100
      }
    }
  }
}

function revokeUrl(url) {
  URL.revokeObjectURL(url)
}

</script>

<template>
  <div class="p-4 max-w-xl mx-auto space-y-4">
    <input type="file" @change="handleFileChange" />
    <button class="px-4 py-2 bg-blue-600 text-white rounded" @click="sendFile">发送文件</button>

    <div v-if="onlineUsers.length">
      <h3>在线用户（除自己）:</h3>
      <ul>
        <li v-for="userId in onlineUsers" :key="userId">
          用户ID: {{ userId }}<br/>
          发送进度: {{ peers[userId]?.sendProgress ?? 0 }}%<br/>
          接收进度: {{ peers[userId]?.receiveProgress ?? 0 }}%
        </li>
      </ul>
    </div>
    <div v-else>
      <p>当前没有在线用户</p>
    </div>

    <h3>已接收文件:</h3>
    <ul>
      <li v-for="file in receivedFiles" :key="file.url" class="mb-2">
        <a :href="file.url" :download="file.name" @click="revokeUrl(file.url)">{{ file.name }}</a>
        （大小: {{ (file.size / 1024).toFixed(2) }} KB，来自: {{ file.from }}）
      </li>
    </ul>
  </div>
</template>
