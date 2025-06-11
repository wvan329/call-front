<script setup>
import { ref, onMounted } from 'vue'

const WS_URL = 'ws://59.110.35.198/wgk/ws/file'
const ICE_SERVERS = [{ urls: 'stun:59.110.35.198:3478' }]

const ws = ref(null)
const peers = ref({})
const onlineUsers = ref([])
const file = ref(null)
const receivedFiles = ref([])  // 每项：{ name, url, size }
const sendProgress = ref(0)  // 发送进度百分比 0~100
const receiveProgress = ref(0)  // 接收进度百分比 0~100
let fileSize = 0
let receivedSize = 0

function handleFileChange(e) {
  file.value = e.target.files[0]
}

onMounted(() => {
  ws.value = new WebSocket(WS_URL)

  ws.value.onmessage = async (e) => {
    const msg = JSON.parse(e.data)
    switch (msg.type) {
      case 'offer':
        await handleOffer(msg)
        break
      case 'answer':
        if (peers.value[msg.from]) {
          if (msg.desc && msg.desc.type) {
            await peers.value[msg.from].pc.setRemoteDescription(new RTCSessionDescription(msg.desc))
          } else {
            console.warn('Invalid answer desc', msg.desc)
          }
        }
        break
      // 其他情况...
    }
  }

})

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
  let filename = 'received_' + Date.now()
  receivedSize = 0
  receiveProgress.value = 0

  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'meta' && msg.filename && msg.size) {
          filename = msg.filename
          fileSize = msg.size
          receiveProgress.value = 0
          return
        }
      } catch {
        if (e.data === 'EOF') {
          const blob = new Blob(chunks)
          const url = URL.createObjectURL(blob)
          receivedFiles.value.push({ name: filename, url, size: blob.size })
          receiveProgress.value = 100
        }
        return
      }
    } else {
      chunks.push(e.data)
      receivedSize += e.data.byteLength || e.data.length
      receiveProgress.value = Math.min(100, Math.floor((receivedSize / fileSize) * 100))
    }
  }
}

async function sendFile() {
  if (!file.value) return

  fileSize = file.value.size
  sendProgress.value = 0

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
      desc: pc.localDescription
    }))

    const MAX_BUFFER = 16 * 1024 * 1024
    dc.onopen = async () => {
      // 先发元信息
      dc.send(JSON.stringify({ type: 'meta', filename: file.value.name, size: fileSize }))

      const reader = file.value.stream().getReader()
      let sentSize = 0
      let { value, done } = await reader.read()

      while (!done) {
        // 等待缓冲区空闲
        while (dc.bufferedAmount > MAX_BUFFER) {
          await new Promise(res => setTimeout(res, 10))
        }

        // 确认 DataChannel 还是 open 状态
        if (dc.readyState !== 'open') {
          console.warn('DataChannel is not open anymore, stop sending')
          break
        }

        dc.send(value)
        sentSize += value.byteLength || value.length
        sendProgress.value = Math.min(100, Math.floor((sentSize / fileSize) * 100))

          ; ({ value, done } = await reader.read())
      }

      if (dc.readyState === 'open') {
        dc.send('EOF')
        sendProgress.value = 100
      }
    }

  }
}

</script>  

<template>
  <div>

    <input type="file" @change="handleFileChange" />
    <button @click="sendFile">发送文件</button>

    <p>发送进度：{{ sendProgress }}%</p>
    <p>接收进度：{{ receiveProgress }}%</p>

    <h3>已接收文件：</h3>
    <ul>
      <li v-for="file in receivedFiles" :key="file.url">
        <a :href="file.url" :download="file.name">{{ file.name }}</a>
      </li>
    </ul>
  </div>
</template>
