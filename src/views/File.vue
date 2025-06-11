<script setup>
import { ref, onMounted } from 'vue'

const WS_URL = 'ws://59.110.35.198/wgk/ws/file'
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }]

const ws = ref(null)
const peers = ref({})
const selfId = ref('')
const onlineUsers = ref([])
const file = ref(null)

onMounted(() => {
  ws.value = new WebSocket(WS_URL)

  ws.value.onmessage = async (e) => {
    const msg = JSON.parse(e.data)
    if (msg.type === 'session-id') {
      selfId.value = msg.id
    } else if (msg.type === 'user-list') {
      onlineUsers.value = msg.users.filter(id => id !== selfId.value)
    } else if (msg.type === 'offer') {
      handleOffer(msg)
    } else if (msg.type === 'answer') {
      await peers.value[msg.from].pc.setRemoteDescription(msg.desc)
    } else if (msg.type === 'candidate') {
      await peers.value[msg.from].pc.addIceCandidate(msg.candidate)
    }
  }
})

// 建立连接 & 发送 offer
async function sendFile() {
  if (!file.value) return
  for (const userId of onlineUsers.value) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const dc = pc.createDataChannel('file')
    setupDataChannel(dc)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        ws.value.send(JSON.stringify({ type: 'candidate', to: userId, candidate }))
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    peers.value[userId] = { pc, dc }

    ws.value.send(JSON.stringify({ type: 'offer', to: userId, desc: offer }))

    // 控制速率发送文件（每 50ms 一块）
    const chunkSize = 16 * 1024
    const reader = file.value.stream().getReader()

    async function sendChunk() {
      const { value, done } = await reader.read()
      if (done) return dc.send('EOF')
      if (dc.bufferedAmount > 16 * 1024 * 1024) {
        setTimeout(sendChunk, 100)
      } else {
        dc.send(value)
        setTimeout(sendChunk, 50)
      }
    }
    sendChunk()
  }
}

// 接收 offer，创建 answer 和 dataChannel
async function handleOffer(msg) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  peers.value[msg.from] = { pc, dc: null }

  pc.ondatachannel = (e) => {
    const chunks = []
    const dc = e.channel
    dc.onmessage = (ev) => {
      if (ev.data === 'EOF') {
        const blob = new Blob(chunks)
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'received_' + Date.now()
        a.click()
      } else {
        chunks.push(ev.data)
      }
    }
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.value.send(JSON.stringify({ type: 'candidate', to: msg.from, candidate }))
    }
  }

  await pc.setRemoteDescription(msg.desc)
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  ws.value.send(JSON.stringify({ type: 'answer', to: msg.from, desc: answer }))
}

function setupDataChannel(dc) {
  dc.onopen = () => console.log('DataChannel open')
}
</script>

<template>
  <div class="p-4 space-y-4">
    <input type="file" @change="e => file.value = e.target.files[0]" />
    <button @click="sendFile" class="px-4 py-2 bg-blue-500 text-white rounded">发送文件</button>
    <p>在线用户：{{ onlineUsers }}</p>
  </div>
</template>
