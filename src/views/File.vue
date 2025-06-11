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
        if (peers.value[msg.from]) {
          await peers.value[msg.from].pc.setRemoteDescription(new RTCSessionDescription(msg.desc))
        }
        break
      case 'candidate':
        const peer = peers.value[msg.from]
        if (peer) {
          if (peer.pc.remoteDescription) {
            await peer.pc.addIceCandidate(msg.candidate)
          } else {
            peer.pendingCandidates.push(msg.candidate)
          }
        }
        break
    }
  }
})

async function sendFile() {
  if (!file.value) return

  for (const userId of onlineUsers.value) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    const dc = pc.createDataChannel('file')
    const pendingCandidates = []

    peers.value[userId] = { pc, dc, pendingCandidates }

    setupReceiverDataChannel(dc)

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
      desc: pc.localDescription // 传的是对象，不用手动 stringify
    }))

    const reader = file.value.stream().getReader()
    const MAX_BUFFER = 16 * 1024 * 1024

    async function sendChunks() {
      let { value, done } = await reader.read()
      while (!done) {
        if (dc.bufferedAmount > MAX_BUFFER) {
          await new Promise(res => setTimeout(res, 10))
        } else {
          dc.send(value)
          ;({ value, done } = await reader.read())
        }
      }
      dc.send('EOF')
    }

    dc.onopen = () => sendChunks()
  }
}

async function handleOffer(msg) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  const pendingCandidates = []
  peers.value[msg.from] = { pc, pendingCandidates }

  pc.ondatachannel = (e) => {
    setupReceiverDataChannel(e.channel)
  }

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.value.send(JSON.stringify({ type: 'candidate', to: msg.from, candidate }))
    }
  }

  await pc.setRemoteDescription(new RTCSessionDescription(msg.desc))

  // 处理早到的 candidates
  for (const c of pendingCandidates) {
    await pc.addIceCandidate(c)
  }

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  ws.value.send(JSON.stringify({
    type: 'answer',
    to: msg.from,
    desc: pc.localDescription
  }))
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
