<template>
  <div class="webrtc-broadcast-container">
    <h2>WebRTC File Broadcast</h2>

    <div class="connection-status">
      WebSocket Status:
      <span :class="{'status-connected': isWsConnected, 'status-disconnected': !isWsConnected}">
        {{ isWsConnected ? 'Connected' : 'Disconnected' }}
      </span>
      (My ID: {{ mySessionId || 'Connecting...' }})
    </div>

    <div class="broadcast-section">
      <h3>Broadcast File</h3>
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="broadcastFile" :disabled="!selectedFile || !isWsConnected">
        Broadcast File
      </button>
      <p v-if="selectedFile">Selected: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
      <div v-if="sendProgress > 0 && sendProgress < 100" class="progress-bar-container">
        <div class="progress-bar" :style="{ width: sendProgress + '%' }"></div>
        <span>{{ sendProgress.toFixed(1) }}%</span>
      </div>
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
    </div>

    <div class="clients-section">
      <h3>Connected Clients ({{ connectedClients.length }})</h3>
      <ul>
        <li v-for="client in connectedClients" :key="client.id">
          {{ client.id }} ({{ client.status }})
        </li>
      </ul>
    </div>

    <div class="received-files">
      <h3>Received Files</h3>
      <ul v-if="receivedFiles.length > 0">
        <li v-for="(file, index) in receivedFiles" :key="index">
          <a :href="file.url" :download="file.name">{{ file.name }}</a> ({{ formatBytes(file.size) }})
        </li>
      </ul>
      <p v-else>No files received yet.</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const ws = ref(null);
const isWsConnected = ref(false);
const mySessionId = ref('');
const connectedClients = ref([]);
const selectedFile = ref(null);
const sendProgress = ref(0);
const errorMessage = ref('');
const receivedFiles = ref([]);

// WebSocket connection
const connectWebSocket = () => {
  ws.value = new WebSocket('ws://59.110.35.198/wgk/ws');

  ws.value.onopen = () => {
    isWsConnected.value = true;
    // Request our session ID
    ws.value.send(JSON.stringify({ type: 'get-id' }));
  };

  ws.value.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      if (data.type === 'session-id') {
        mySessionId.value = data.id;
      } 
      else if (data.type === 'client-list') {
        connectedClients.value = data.clients;
      }
      else if (data.type === 'file') {
        // Handle received file
        const blob = new Blob([new Uint8Array(data.content)], { type: data.type });
        const url = URL.createObjectURL(blob);
        receivedFiles.value.push({
          name: data.name,
          size: data.size,
          url: url
        });
      }
    } catch (e) {
      errorMessage.value = 'Error processing message: ' + e.message;
    }
  };

  ws.value.onclose = () => {
    isWsConnected.value = false;
    setTimeout(connectWebSocket, 5000); // Reconnect after 5 seconds
  };

  ws.value.onerror = (error) => {
    errorMessage.value = 'WebSocket error: ' + error.message;
    ws.value.close();
  };
};

// File handling
const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  sendProgress.value = 0;
  errorMessage.value = '';
};

const broadcastFile = () => {
  if (!selectedFile.value || !ws.value || ws.value.readyState !== WebSocket.OPEN) {
    errorMessage.value = 'Cannot broadcast - no file selected or connection not ready';
    return;
  }

  const file = selectedFile.value;
  const reader = new FileReader();

  reader.onload = (event) => {
    const content = Array.from(new Uint8Array(event.target.result));
    
    // Send file metadata first
    ws.value.send(JSON.stringify({
      type: 'file-meta',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream'
    }));

    // Then send file in chunks (simplified - in production you'd want to chunk it)
    ws.value.send(JSON.stringify({
      type: 'file-data',
      name: file.name,
      content: content,
      size: file.size
    }));

    sendProgress.value = 100;
    selectedFile.value = null;
    document.querySelector('input[type="file"]').value = '';
  };

  reader.onerror = (error) => {
    errorMessage.value = 'Error reading file: ' + error.message;
  };

  reader.readAsArrayBuffer(file);
};

const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

onMounted(() => {
  connectWebSocket();
});

onUnmounted(() => {
  if (ws.value) {
    ws.value.close();
  }
});
</script>

<style scoped>
.webrtc-broadcast-container {
  font-family: Arial, sans-serif;
  max-width: 600px;
  margin: 20px auto;
  padding: 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

h2, h3 {
  color: #333;
  margin-bottom: 15px;
  border-bottom: 1px solid #eee;
  padding-bottom: 5px;
}

.connection-status {
  margin-bottom: 20px;
  padding: 10px;
  background-color: #eef;
  border-radius: 4px;
}

.status-connected {
  color: green;
  font-weight: bold;
}

.status-disconnected {
  color: red;
  font-weight: bold;
}

.broadcast-section {
  margin-bottom: 20px;
  padding: 15px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
}

.broadcast-section input[type="file"] {
  margin-right: 10px;
}

.broadcast-section button {
  padding: 8px 15px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.broadcast-section button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.progress-bar-container {
  width: 100%;
  background-color: #e0e0e0;
  border-radius: 5px;
  margin-top: 10px;
  height: 20px;
  position: relative;
}

.progress-bar {
  height: 100%;
  background-color: #4CAF50;
  border-radius: 5px;
  transition: width 0.3s ease;
}

.progress-bar-container span {
  position: absolute;
  width: 100%;
  text-align: center;
  line-height: 20px;
  color: #333;
  font-size: 0.9em;
}

.clients-section, .received-files {
  margin-top: 20px;
  padding: 15px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
}

.clients-section ul, .received-files ul {
  list-style: none;
  padding: 0;
}

.clients-section li, .received-files li {
  padding: 5px 0;
  border-bottom: 1px dotted #eee;
}

.error-message {
  color: red;
  margin-top: 10px;
}

a {
  color: #007bff;
  text-decoration: none;
}

a:hover {
  text-decoration: underline;
}
</style>