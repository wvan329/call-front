<template>
  <div class="chat-container">
    <div class="header">
      <h1>语音聊天室</h1>
      <p>已连接: {{ Object.keys(peers).length + 1 }} 人</p>
    </div>
    <div class="participants">
      <div class="participant">
        <div class="avatar-wrapper" :class="{ 'is-speaking': isSpeaking }">
          <img src="https://i.pravatar.cc/150?u=local" alt="Local User" class="avatar">
        </div>
        <p class="name">你</p>
      </div>
      <div v-for="(peer, peerId) in peers" :key="peerId" class="participant">
        <div class="avatar-wrapper">
          <img :src="`https://i.pravatar.cc/150?u=${peerId}`" alt="Remote User" class="avatar">
        </div>
         <p class="name">用户 {{ peerId.slice(0, 4) }}</p>
        <audio :ref="el => { if (el) peer.audioEl = el }" autoplay></audio>
      </div>
    </div>
    <div class="controls">
      <button @click="toggleMute" class="control-btn" :class="{ 'is-muted': isMuted }">
        <svg v-if="!isMuted" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v-2a7 7 0 0 0-1.23-3.95"></path><line x1="12" y1="19" x2="12" y2="22"></line></svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

// --- 配置 ---
// 确保将 'localhost:8080' 替换为你的后端 WebSocket 服务器地址和端口
const WEBSOCKET_URL = 'ws://localhost:8080/signal'; 

// --- 响应式状态 ---
const localStream = ref(null);
const peers = ref({}); // 存储所有远程连接 { peerId: { pc, audioEl } }
const ws = ref(null);
const isMuted = ref(false);
const isSpeaking = ref(false);

let audioContext, analyser, microphone, javascriptNode;

// --- WebRTC 配置 ---
const pc_config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

// --- WebSocket 处理 ---
const connectWebSocket = () => {
  ws.value = new WebSocket(WEBSOCKET_URL);

  ws.value.onopen = () => {
    console.log("WebSocket 连接成功!");
    initLocalMedia(); 
  };

  ws.value.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    const fromId = message.from;

    if (message.type === 'offer') {
      console.log(`收到来自 ${fromId} 的 offer`);
      const peer = createPeerConnection(fromId);
      await peer.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendMessage({ type: 'answer', sdp: peer.pc.localDescription, to: fromId });
    } else if (message.type === 'answer') {
       console.log(`收到来自 ${fromId} 的 answer`);
      if (peers.value[fromId]) {
        await peers.value[fromId].pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
      }
    } else if (message.type === 'candidate') {
       console.log(`收到来自 ${fromId} 的 ICE candidate`);
      if (peers.value[fromId]) {
        await peers.value[fromId].pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      }
    } else if (message.type === 'user-joined') {
        console.log(`用户 ${fromId} 加入了房间`);
        // 当一个新用户加入时，向他发送 offer
        const peer = createPeerConnection(fromId);
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        sendMessage({ type: 'offer', sdp: peer.pc.localDescription, to: fromId });
    } else if (message.type === 'user-left') {
        console.log(`用户 ${fromId} 离开了房间`);
        if (peers.value[fromId]) {
            peers.value[fromId].pc.close();
            delete peers.value[fromId];
        }
    }
  };
  
  ws.value.onclose = () => {
    console.log("WebSocket 连接关闭");
  };

  ws.value.onerror = (error) => {
    console.error("WebSocket 错误:", error);
  };
};

const sendMessage = (message) => {
    // 后端实现的是广播模式，但为了明确信令目标，我们仍可以加上 to/from
    // 后端 handleTextMessage 稍作修改即可支持点对点信令
    // 这里我们假设后端能处理，或者直接广播
    ws.value.send(JSON.stringify(message));
};


// --- WebRTC 核心功能 ---
const initLocalMedia = async () => {
  try {
    localStream.value = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    
    // 初始化语音活动检测
    setupSpeechDetection();

    // 通知其他所有用户你的加入
    sendMessage({ type: 'user-joined' });

  } catch (error) {
    console.error("获取麦克风权限失败:", error);
    alert("无法获取麦克风权限，语音聊天功能无法使用。");
  }
};

const createPeerConnection = (peerId) => {
  const pc = new RTCPeerConnection(pc_config);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendMessage({ type: 'candidate', candidate: event.candidate, to: peerId });
    }
  };

  pc.ontrack = (event) => {
    console.log(`收到来自 ${peerId} 的音轨`);
    if (peers.value[peerId] && event.streams && event.streams[0]) {
       // 等待DOM更新后，将流附加到audio元素
       // Vue的ref机制会自动处理
       peers.value[peerId].audioEl.srcObject = event.streams[0];
    }
  };
  
  // 将本地音频轨道添加到连接中
  if (localStream.value) {
    localStream.value.getTracks().forEach(track => {
      pc.addTrack(track, localStream.value);
    });
  }

  peers.value[peerId] = { pc, audioEl: null };
  return peers.value[peerId];
};


// --- UI 控制 ---
const toggleMute = () => {
  if (!localStream.value) return;
  localStream.value.getAudioTracks().forEach(track => {
    track.enabled = !track.enabled;
    isMuted.value = !track.enabled;
  });
};

// --- 语音活动检测 ---
const setupSpeechDetection = () => {
    if (!localStream.value || !localStream.value.getAudioTracks().length) return;

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser();
    microphone = audioContext.createMediaStreamSource(localStream.value);
    javascriptNode = audioContext.createScriptProcessor(2048, 1, 1);

    analyser.smoothingTimeConstant = 0.8;
    analyser.fftSize = 1024;

    microphone.connect(analyser);
    analyser.connect(javascriptNode);
    javascriptNode.connect(audioContext.destination);

    javascriptNode.onaudioprocess = () => {
        const array = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(array);
        let values = 0;

        const length = array.length;
        for (let i = 0; i < length; i++) {
            values += (array[i]);
        }

        const average = values / length;
        // 设置一个阈值来判断是否在说话
        isSpeaking.value = average > 15; 
    };
};


// --- Vue 生命周期钩子 ---
onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
    // 清理资源
    sendMessage({ type: 'user-left' });

    if (ws.value) {
        ws.value.close();
    }
    if (localStream.value) {
        localStream.value.getTracks().forEach(track => track.stop());
    }
    Object.values(peers.value).forEach(peer => peer.pc.close());

    if (javascriptNode) javascriptNode.onaudioprocess = null;
    if (audioContext) audioContext.close();
});

</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap');

.chat-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  height: 100vh;
  width: 100%;
  background-color: #121212;
  color: #e0e0e0;
  font-family: 'Poppins', sans-serif;
  padding: 2rem;
  box-sizing: border-box;
}

.header {
  text-align: center;
  margin-bottom: 2rem;
}

.header h1 {
  font-size: 2.5rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: #ffffff;
}

.header p {
  font-size: 1rem;
  color: #a0a0a0;
}

.participants {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: flex-start;
  gap: 2rem;
  flex-grow: 1;
  width: 100%;
  max-width: 1200px;
}

.participant {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.avatar-wrapper {
  position: relative;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  padding: 6px;
  background: #333;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
  transition: all 0.3s ease;
}

.avatar-wrapper::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 50%;
  border: 3px solid transparent;
  transition: border-color 0.3s ease;
}

.avatar-wrapper.is-speaking::before {
    border-color: #4CAF50; /* 说话时显示绿色光环 */
    animation: pulse 1.5s infinite;
}


.avatar {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.name {
  margin-top: 1rem;
  font-weight: 600;
  color: #fafafa;
}

.controls {
  padding: 1.5rem 0;
}

.control-btn {
  background-color: #282828;
  border: none;
  border-radius: 50%;
  width: 64px;
  height: 64px;
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: pointer;
  transition: background-color 0.2s ease;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}

.control-btn:hover {
  background-color: #383838;
}

.control-btn.is-muted {
  background-color: #e74c3c;
}

.control-btn.is-muted:hover {
  background-color: #c0392b;
}

.control-btn svg {
  color: #ffffff;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7);
  }
  70% {
    box-shadow: 0 0 0 10px rgba(76, 175, 80, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0);
  }
}
</style>