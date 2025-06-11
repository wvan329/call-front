<template>
  <div class="file-transfer-container">
    <h2>File Transfer</h2>

    <div class="connection-status">
      WebSocket Status:
      <span :class="{'status-connected': isConnected, 'status-disconnected': !isConnected}">
        {{ isConnected ? 'Connected' : 'Disconnected' }}
      </span>
      (ID: {{ currentSessionId }})
    </div>

    <div class="file-input-section">
      <input type="file" @change="handleFileChange" ref="fileInput" />
      <button @click="sendFile" :disabled="!selectedFile || !isConnected">Send File</button>
      <select v-model="selectedRecipientId" class="recipient-select">
        <option value="">Broadcast (Send to all)</option>
        <option v-for="sessionId in availableSessions" :key="sessionId" :value="sessionId">
          {{ sessionId }}
        </option>
      </select>
      <p v-if="selectedFile">Selected: {{ selectedFile.name }} ({{ formatBytes(selectedFile.size) }})</p>
      <p v-if="sendFileError" class="error-message">{{ sendFileError }}</p>
    </div>

    <div class="message-log">
      <h3>Message Log</h3>
      <div v-for="(log, index) in messageLogs" :key="index" :class="['log-item', log.type]">
        <span class="log-timestamp">[{{ new Date(log.timestamp).toLocaleTimeString() }}]</span>
        <span class="log-sender">From: {{ log.from || 'Me' }}</span>
        <span v-if="log.to" class="log-recipient">To: {{ log.to }}</span>
        <span class="log-content">{{ log.content }}</span>
      </div>
    </div>

    <div class="received-files-section">
      <h3>Received Files</h3>
      <ul v-if="receivedFiles.length > 0">
        <li v-for="(file, index) in receivedFiles" :key="index" class="received-file-item">
          <p>
            <span class="file-info">From: {{ file.from }} - {{ file.fileName }} ({{ formatBytes(file.fileSize) }})</span>
            <a :href="file.url" :download="file.fileName" class="download-link">Download</a>
          </p>
        </li>
      </ul>
      <p v-else>No files received yet.</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';

const ws = ref(null);
const isConnected = ref(false);
const currentSessionId = ref('');
const selectedFile = ref(null);
const receivedFiles = ref([]);
const messageLogs = ref([]);
const sendFileError = ref('');
const availableSessions = ref([]); // To store other connected session IDs for point-to-point
const selectedRecipientId = ref(''); // For selecting a specific recipient

const wsUrl = 'ws://59.110.35.198/wgk/ws'; // Adjust if your WebSocket endpoint is different

// Helper to format file size
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

// Log messages for debugging
const addLog = (type, content, from = null, to = null) => {
  messageLogs.value.push({
    type,
    content,
    from,
    to,
    timestamp: Date.now(),
  });
};

const connectWebSocket = () => {
  ws.value = new WebSocket(wsUrl);

  ws.value.onopen = () => {
    isConnected.value = true;
    addLog('system', 'WebSocket Connected.');
    // Periodically send ping to keep connection alive
    setInterval(() => {
      if (ws.value && ws.value.readyState === WebSocket.OPEN) {
        ws.value.send('ping');
        // addLog('sent', 'ping'); // Uncomment for verbose ping logging
      }
    }, 25000); // Send ping every 25 seconds
  };

  ws.value.onmessage = async (event) => {
    const message = event.data;
    // addLog('received', `Raw: ${message}`); // Log raw received messages for debugging

    if (message === 'pong') {
      // addLog('received', 'pong'); // Uncomment for verbose pong logging
      return;
    }

    try {
      const parsedMessage = JSON.parse(message);
      const fromId = parsedMessage.from; // Sender's ID from backend
      const type = parsedMessage.type;

      // Update current session ID if this is the first message from the server
      if (!currentSessionId.value && fromId) {
        // This is a heuristic: the first message typically contains the session ID.
        // A more robust way is for the server to explicitly send the session ID.
        // For Spring's WebSocketSession, the ID is generated server-side.
        // A simple way to get it is to have the server send a 'connection-info' message.
        // For now, let's assume `parsedMessage.from` will eventually be our own ID
        // if we broadcast a message and get it back, or it's implicitly known.
        // For demonstration, we often don't have direct access to our own session ID
        // from the client without server sending it explicitly.
        // Let's set it to 'Me' for now and update later if we get it from a specific server message.
        // If the server sends {"type": "session-id", "id": "ourId"}, we could capture it.
        // For this example, we'll rely on the server broadcasting the 'user-left' or a new
        // connection to imply other sessions, and not show our own ID unless we receive it.
        // To properly get own ID, server needs to send it. For now, we'll display 'Me' for own actions.
        // The server puts `from` field for *other* sessions, so 'Me' is fine for client's perspective.
        // We can get the ID when `afterConnectionEstablished` happens on server and server sends it.
      }


      // --- Handle different message types ---
      if (type === 'file') {
        const { fileName, fileType, data, from } = parsedMessage;
        addLog('received', `File: ${fileName} (${formatBytes(atob(data).length)})`, from);
        // Decode Base64 to ArrayBuffer
        const byteCharacters = atob(data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: fileType });
        const url = URL.createObjectURL(blob);

        receivedFiles.value.push({
          fileName,
          fileType,
          fileSize: byteArray.length,
          url,
          from: from || 'Unknown', // 'from' should always be present from backend
        });
      } else if (type === 'user-left') {
        // Update available sessions list
        const leftUserId = parsedMessage.from;
        availableSessions.value = availableSessions.value.filter(id => id !== leftUserId);
        addLog('system', `User disconnected: ${leftUserId}`);
      } else {
        // This is a generic signaling message or other text message
        addLog('received', `JSON: ${JSON.stringify(parsedMessage)}`, from, parsedMessage.to);

        // For simplicity, let's assume any incoming message's 'from' is a potential peer
        // Exclude our own session ID if we knew it, or if it's the 'from' field of our broadcast
        if (fromId && fromId !== currentSessionId.value && !availableSessions.value.includes(fromId)) {
            availableSessions.value.push(fromId);
        }
      }
    } catch (e) {
      // If it's not JSON, it might be a simple text message (like the initial "Connected: sessionId" from server)
      addLog('received', `Text: ${message}`);
      if (message.startsWith("Connected: ")) {
          currentSessionId.value = message.substring("Connected: ".length);
      }
    }
  };

  ws.value.onclose = () => {
    isConnected.value = false;
    currentSessionId.value = '';
    addLog('system', 'WebSocket Disconnected. Attempting to reconnect in 5 seconds...');
    setTimeout(connectWebSocket, 5000); // Attempt to reconnect
  };

  ws.value.onerror = (error) => {
    addLog('error', `WebSocket Error: ${error.message || error}`);
    ws.value.close(); // Close to trigger onclose and reconnect
  };
};

const handleFileChange = (event) => {
  selectedFile.value = event.target.files[0];
  sendFileError.value = ''; // Clear previous errors
};

const sendFile = async () => {
  if (!ws.value || ws.value.readyState !== WebSocket.OPEN) {
    sendFileError.value = 'WebSocket is not connected.';
    return;
  }
  if (!selectedFile.value) {
    sendFileError.value = 'No file selected.';
    return;
  }

  const reader = new FileReader();

  reader.onload = (e) => {
    try {
      const arrayBuffer = e.target.result;
      const base64String = btoa(
        new Uint8Array(arrayBuffer)
          .reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      const messagePayload = {
        type: 'file',
        fileName: selectedFile.value.name,
        fileType: selectedFile.value.type || 'application/octet-stream', // Fallback type
        fileSize: selectedFile.value.size,
        data: base64String,
      };

      if (selectedRecipientId.value) {
        messagePayload.to = selectedRecipientId.value;
        addLog('sent', `Sending file to ${selectedRecipientId.value}: ${selectedFile.value.name}`, 'Me', selectedRecipientId.value);
      } else {
        addLog('sent', `Broadcasting file: ${selectedFile.value.name}`, 'Me');
      }

      ws.value.send(JSON.stringify(messagePayload));
      selectedFile.value = null; // Clear selected file after sending
      if (currentSessionId.value === selectedRecipientId.value || !selectedRecipientId.value) {
         // If broadcasting or sending to self, we'll receive our own message, so don't clear until then
         // But for a true point-to-point where we don't receive our own send, clear it here.
         // For simplicity, let's clear it regardless.
      }
      // Clear file input visually
      if (document.querySelector('input[type="file"]')) {
        document.querySelector('input[type="file"]').value = '';
      }

    } catch (error) {
      console.error('Error sending file:', error);
      sendFileError.value = 'Error processing file: ' + error.message;
    }
  };

  reader.onerror = (error) => {
    console.error('FileReader error:', error);
    sendFileError.value = 'Error reading file: ' + error.message;
  };

  reader.readAsArrayBuffer(selectedFile.value);
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
.file-transfer-container {
  font-family: Arial, sans-serif;
  max-width: 800px;
  margin: 20px auto;
  padding: 20px;
  border: 1px solid #ddd;
  border-radius: 8px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  background-color: #f9f9f9;
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
  border: 1px solid #dde;
}

.status-connected {
  color: green;
  font-weight: bold;
}

.status-disconnected {
  color: red;
  font-weight: bold;
}

.file-input-section {
  margin-bottom: 20px;
  padding: 15px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
}

.file-input-section input[type="file"] {
  margin-right: 10px;
  padding: 5px;
}

.file-input-section button {
  padding: 8px 15px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.3s ease;
  margin-right: 10px;
}

.file-input-section button:disabled {
  background-color: #cccccc;
  cursor: not-allowed;
}

.file-input-section button:hover:enabled {
  background-color: #0056b3;
}

.file-input-section p {
  margin-top: 10px;
  color: #555;
}

.recipient-select {
  padding: 7px;
  border: 1px solid #ccc;
  border-radius: 4px;
  margin-left: 10px;
  min-width: 150px;
}

.message-log {
  margin-top: 20px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 15px;
  max-height: 300px;
  overflow-y: auto;
}

.log-item {
  padding: 5px 0;
  border-bottom: 1px dotted #eee;
  font-size: 0.9em;
  color: #666;
}

.log-item:last-child {
  border-bottom: none;
}

.log-timestamp {
  color: #999;
  margin-right: 5px;
}

.log-sender, .log-recipient {
  font-weight: bold;
  margin-right: 5px;
}

.log-item.system {
  color: #0056b3;
}
.log-item.sent {
  color: #28a745;
}
.log-item.received {
  color: #ffc107;
}
.log-item.error {
  color: #dc3545;
  font-weight: bold;
}

.received-files-section {
  margin-top: 20px;
  background-color: #fff;
  border: 1px solid #eee;
  border-radius: 4px;
  padding: 15px;
}

.received-files-section ul {
  list-style: none;
  padding: 0;
}

.received-file-item {
  padding: 10px 0;
  border-bottom: 1px dotted #eee;
}

.received-file-item:last-child {
  border-bottom: none;
}

.file-info {
  margin-right: 15px;
  color: #333;
}

.download-link {
  display: inline-block;
  padding: 5px 10px;
  background-color: #6c757d;
  color: white;
  text-decoration: none;
  border-radius: 4px;
  transition: background-color 0.3s ease;
}

.download-link:hover {
  background-color: #5a6268;
}

.error-message {
  color: red;
  margin-top: 10px;
}
</style>