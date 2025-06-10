<template>
  <div class="p-4">
    <h2 class="text-xl mb-4">语音房间</h2>

    <!-- 按钮，按下时说话，松开时停止 -->
    <button 
      @mousedown="startTalk" 
      @mouseup="stopTalk" 
      class="p-4 bg-blue-500 text-white rounded">
      按住说话
    </button>

    <!-- 显示当前状态文字 -->
    <p v-if="status">{{ status }}</p>
  </div>
</template>

<script setup>
// Vue3 的 Composition API 写法
import { ref, onMounted } from 'vue'
// 引入封装的 WebSocket 信令工具
import { connectSignaling, sendSignal } from '@/utils/signaling'

// 保存本地音频流（从麦克风采集）
const localStream = ref(null)

// 创建一个 WebRTC 连接对象，用于点对点音频通信
const pc = new RTCPeerConnection()

// 用于显示提示信息（比如“正在说话...”）
const status = ref('')

// 当用户按下按钮，准备开始说话
const startTalk = async () => {
  // 如果没有麦克风流，就什么都不做
  if (!localStream.value) return

  // 把音频轨道加入到 WebRTC 的连接中（每个 Track 都代表一个音频/视频流）
  localStream.value.getTracks().forEach(track => {
    pc.addTrack(track, localStream.value)
  })

  // 创建一个 SDP offer，这是 WebRTC 的连接协商第一步
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  // 把 offer 通过 WebSocket 发给服务器，再由服务器转发给其他用户
  sendSignal({ type: 'offer', sdp: offer.sdp })

  // 更新状态提示
  status.value = '正在发送语音...'
}

// 松开按钮时
const stopTalk = () => {
  // 这里只是更新状态，实际不需要断开连接（保持连接持续）
  status.value = '已停止'
}

// 页面加载完毕时执行的逻辑
onMounted(async () => {
  // 请求浏览器获取麦克风权限，并保存音频流
  localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true })

  // 建立 WebSocket 连接，接收来自服务器的信令消息
  connectSignaling(async (msg) => {
    // 收到远程用户的 offer
    if (msg.type === 'offer') {
      // 设置远程 offer 到 peerConnection
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }))

      // 获取本地音频并添加轨道
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(track => pc.addTrack(track, stream))

      // 创建 answer，回应 offer
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)

      // 把 answer 发给远端用户（通过服务器中转）
      sendSignal({ type: 'answer', sdp: answer.sdp })
    }

    // 收到远程用户的 answer
    if (msg.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: msg.sdp }))
    }

    // 收到 ICE 候选地址（用于 NAT 打洞）
    if (msg.type === 'ice') {
      pc.addIceCandidate(new RTCIceCandidate(msg.candidate))
    }
  })

  // 本地发现了 ICE 候选信息，发送给远端
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: 'ice', candidate: event.candidate })
    }
  }

  // 收到远程音频轨道时
  pc.ontrack = (event) => {
    // 创建一个 audio 标签播放远程语音
    const audio = new Audio()
    audio.srcObject = event.streams[0]
    audio.play()
  }
})
</script>
