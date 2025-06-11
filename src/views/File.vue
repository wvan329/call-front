<template>
  <div style="padding: 16px; max-width: 600px; margin: auto;">
    <h2>点对点文件传输</h2>
    <div>
      <p>我的ID：<strong>{{ myId }}</strong></p>
      <label>目标ID: <input v-model="targetId" placeholder="请输入对方ID" /></label>
    </div>
    <div style="margin-top: 10px;">
      <input type="file" @change="onFileChange" />
    </div>

    <div v-if="receiveProgress >= 0" style="margin-top: 10px;">
      <p>接收进度: {{ receiveProgress }}%</p>
    </div>

    <div v-if="sendProgress >= 0" style="margin-top: 10px;">
      <p>发送进度: {{ sendProgress }}%</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const SIGNALING_SERVER = 'ws://59.110.35.198/wgk/ws' // 改成你的后端地址

const myId = ref('')
const targetId = ref('')

let localConnection = null
let dataChannel = null

const sendProgress = ref(-1)
const receiveProgress = ref(-1)

let websocket = null

// 缓存文件数据
let fileToSend = null
let fileReader = null

// 接收文件相关
let receivedBuffers = []
let receivedSize = 0
let expectedFileSize = 0
let expectedFileName = ''

function setupWebSocket() {
  websocket = new WebSocket(SIGNALING_SERVER)

  websocket.onopen = () => {
    console.log('WebSocket 已连接')
  }

  websocket.onmessage = async (event) => {
    const message = JSON.parse(event.data)

    // 服务端会给你一个 from 字段作为对方的sessionId
    // 第一次连接，设置自己的ID
    if (!myId.value && message.type === 'welcome') {
      myId.value = message.from
      return
    }

    if (message.type === 'user-left') {
      alert(`用户离开了：${message.from}`)
      cleanup()
      return
    }

    if (message.from === myId.value) {
      // 收到自己发的消息，忽略
      return
    }

    switch (message.data?.type) {
      case 'offer':
        await handleOffer(message)
        break
      case 'answer':
        await handleAnswer(message)
        break
      case 'iceCandidate':
        await handleIceCandidate(message)
        break
      default:
        break
    }
  }

  websocket.onclose = () => {
    console.log('WebSocket 已关闭')
  }
}

async function sendSignal(data) {
  if (!targetId.value) {
    alert('请先输入目标ID')
    return
  }
  // 发送格式，后端会加 from
  const message = {
    to: targetId.value,
    data,
  }
  websocket.send(JSON.stringify(message))
}

function createConnection() {
  localConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  })

  dataChannel = localConnection.createDataChannel('fileTransfer')

  dataChannel.binaryType = 'arraybuffer'

  dataChannel.onopen = () => {
    console.log('DataChannel 已打开，可以传文件了')
  }

  dataChannel.onclose = () => {
    console.log('DataChannel 关闭')
  }

  dataChannel.onerror = (error) => {
    console.error('DataChannel 错误', error)
  }

  dataChannel.onmessage = (event) => {
    handleDataChannelMessage(event)
  }

  localConnection.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'iceCandidate', candidate: event.candidate })
    }
  }

  localConnection.ondatachannel = (event) => {
    dataChannel = event.channel
    dataChannel.binaryType = 'arraybuffer'
    dataChannel.onmessage = (event) => {
      handleDataChannelMessage(event)
    }
    dataChannel.onopen = () => {
      console.log('对端 DataChannel 打开')
    }
  }
}

async function handleOffer(message) {
  if (!localConnection) {
    createConnection()
  }

  await localConnection.setRemoteDescription(new RTCSessionDescription(message.data))

  const answer = await localConnection.createAnswer()
  await localConnection.setLocalDescription(answer)

  sendSignal(answer)
}

async function handleAnswer(message) {
  await localConnection.setRemoteDescription(new RTCSessionDescription(message.data))
}

async function handleIceCandidate(message) {
  if (message.data.candidate) {
    try {
      await localConnection.addIceCandidate(new RTCIceCandidate(message.data.candidate))
    } catch (e) {
      console.warn('添加ICE Candidate失败', e)
    }
  }
}

function onFileChange(event) {
  const file = event.target.files[0]
  if (!file) return
  if (!dataChannel || dataChannel.readyState !== 'open') {
    alert('连接未就绪，无法发送文件')
    return
  }

  fileToSend = file
  sendFile(file)
}

function sendFile(file) {
  const chunkSize = 16 * 1024
  let offset = 0
  sendProgress.value = 0

  // 先发送文件信息，方便接收方准备
  const fileInfo = JSON.stringify({ fileName: file.name, fileSize: file.size })
  dataChannel.send(fileInfo)

  fileReader = new FileReader()
  fileReader.onload = (e) => {
    if (!e.target) return
    const buffer = e.target.result
    dataChannel.send(buffer)
    offset += buffer.byteLength
    sendProgress.value = Math.floor((offset / file.size) * 100)
    if (offset < file.size) {
      readSlice(offset)
    } else {
      console.log('文件发送完毕')
      sendProgress.value = 100
    }
  }

  function readSlice(o) {
    const slice = file.slice(o, o + chunkSize)
    fileReader.readAsArrayBuffer(slice)
  }

  readSlice(0)
}

function handleDataChannelMessage(event) {
  if (typeof event.data === 'string') {
    // 解析文件信息 JSON
    try {
      const info = JSON.parse(event.data)
      if (info.fileName && info.fileSize) {
        expectedFileName = info.fileName
        expectedFileSize = info.fileSize
        receivedBuffers = []
        receivedSize = 0
        receiveProgress.value = 0
        console.log('准备接收文件', info)
      }
    } catch {
      console.warn('收到非JSON文本消息')
    }
  } else {
    // 接收二进制文件块
    receivedBuffers.push(event.data)
    receivedSize += event.data.byteLength
    receiveProgress.value = Math.floor((receivedSize / expectedFileSize) * 100)

    if (receivedSize >= expectedFileSize) {
      // 文件接收完毕，组装下载
      const blob = new Blob(receivedBuffers)
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = expectedFileName || 'file'
      a.click()
      URL.revokeObjectURL(a.href)

      receiveProgress.value = 100
      console.log('文件接收完成')
    }
  }
}

function cleanup() {
  if (dataChannel) {
    dataChannel.close()
    dataChannel = null
  }
  if (localConnection) {
    localConnection.close()
    localConnection = null
  }
  sendProgress.value = -1
  receiveProgress.value = -1
  receivedBuffers = []
  receivedSize = 0
  expectedFileName = ''
  expectedFileSize = 0
}

onMounted(() => {
  setupWebSocket()
  createConnection()
})

onBeforeUnmount(() => {
  cleanup()
  if (websocket) websocket.close()
})

</script>
