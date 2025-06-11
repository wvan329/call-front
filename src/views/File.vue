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

async function sendFile() {
  if (!file.value) return
  for (const userId of onlineUsers.value) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const dc = pc.createDataChannel('file')
    setupReceiverDataChannel(dc)

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        ws.value.send(JSON.stringify({ type: 'candidate', to: userId, candidate }))
      }
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    ws.value.send(JSON.stringify({ type: 'offer', to: userId, desc: offer }))
    peers.value[userId] = { pc, dc }

    // 控制发送速率：最大吞吐策略
    const reader = file.value.stream().getReader()
    const MAX_BUFFER = 16 * 1024 * 1024 // 16MB

    async function sendChunks() {
      let { value, done } = await reader.read()
      while (!done) {
        if (dc.bufferedAmount > MAX_BUFFER) {
          await new Promise(res => setTimeout(res, 10))
          continue
        }
        dc.send(value)
        ;({ value, done } = await reader.read())
      }
      dc.send('EOF')
    }

    dc.onopen = () => sendChunks()
  }
}

async function handleOffer(msg) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  peers.value[msg.from] = { pc }

  pc.ondatachannel = (e) => setupReceiverDataChannel(e.channel)

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

function setupReceiverDataChannel(dc) {
  const chunks = []
  dc.onmessage = (e) => {
    if (e.data === 'EOF') {
      const blob = new Blob(chunks)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'received_' + Date.now()
      a.click()
    } else {
      chunks.push(e.data)
    }
  }
}
</script>

<template>
  <div class="p-4 space-y-4">
    <input type="file" @change="e => file.value = e.target.files[0]" />
    <button @click="sendFile" class="px-4 py-2 bg-blue-600 text-white rounded">发送文件</button>
    <p>在线用户：{{ onlineUsers }}</p>
  </div>
</template>
