const socket = io();

// State management
let localStream;
let peerConnection;
let mediaRecorder;
let audioChunks = [];
const rtcConfig = { 
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ] 
};
let chatHistory = []; 
let isFocused = true;
let unreadCount = 0;
let typingTimeout;

// DOM Elements
const setupDiv = document.getElementById('setup');
const chatContainer = document.getElementById('chat-container');
const msgInput = document.getElementById('msg-input');
const messagesDiv = document.getElementById('messages');
const startBtn = document.getElementById('start-btn');
const partnerNameDisplay = document.getElementById('partner-name');

// Create and inject the Typing Indicator element below the messages
const typingDiv = document.createElement('div');
typingDiv.id = 'typing-indicator';
typingDiv.style.cssText = "padding: 5px 20px; font-size: 0.85rem; font-style: italic; opacity: 0.7; height: 20px;";
messagesDiv.parentNode.insertBefore(typingDiv, messagesDiv.nextSibling);

/**
 * 1. WINDOW FOCUS & NOTIFICATIONS
 */
window.onfocus = () => {
    isFocused = true;
    unreadCount = 0;
    document.title = "Promptly";
};

window.onblur = () => {
    isFocused = false;
};

/**
 * 2. REACTION SYSTEM (Floating Menu)
 */
function showReactionMenu(e, msgElement) {
    // Prevent multiple menus
    const oldMenu = document.querySelector('.reaction-menu');
    if (oldMenu) oldMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'reaction-menu';
    
    // Explicit emoji list for reactions
    const reactionEmojis = ['❤️', '🔥', '😂', '👍', '✨', '😮'];
    
    reactionEmojis.forEach(emoji => {
        const span = document.createElement('span');
        span.innerText = emoji;
        span.onclick = (ev) => {
            ev.stopPropagation();
            applyReaction(msgElement, emoji, false); // Local update
            socket.emit('send-reaction', { emoji: emoji, messageId: msgElement.id }); // Sync to partner
            menu.remove();
        };
        menu.appendChild(span);
    });

    document.body.appendChild(menu);

    // Positioning logic (relative to the message clicked)
    const rect = msgElement.getBoundingClientRect();
    menu.style.left = `${rect.left + (rect.width / 2) - 100}px`;
    menu.style.top = `${window.scrollY + rect.top - 70}px`;

    // Screen boundary check
    if (parseInt(menu.style.left) < 10) menu.style.left = '10px';

    // Click away to close menu
    setTimeout(() => {
        const closeHandler = () => {
            if (menu) menu.remove();
            window.removeEventListener('click', closeHandler);
        };
        window.addEventListener('click', closeHandler);
    }, 50);
}

function applyReaction(el, emoji, fromPartner) {
    let container = el.querySelector('.reaction-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'reaction-container';
        el.appendChild(container);
    }
    
    const reactorClass = fromPartner ? 'res-partner' : 'res-me';
    let badge = container.querySelector(`.${reactorClass}`);
    
    if (!badge) {
        badge = document.createElement('span');
        badge.className = `reaction-badge ${reactorClass}`;
        container.appendChild(badge);
    }
    badge.innerText = emoji;
}

/**
 * 3. MESSAGE RENDERING & SMART SCROLL
 */
function addMessage(data) {
    const side = data.sender === 'Me' ? 'me' : 'stranger';
    const msgDiv = document.createElement('div');
    msgDiv.className = `msg ${side}`;
    msgDiv.id = data.id; // Use the ID passed from the server
    
    // Generate Current Timestamp
    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const timestampHTML = `<span class="timestamp" style="display:block; font-size:0.7rem; margin-top:5px; opacity:0.6;">${timeStr}</span>`;

    if (data.type === 'image') {
        const img = document.createElement('img');
        img.src = data.text;
        img.style.maxWidth = '100%';
        img.style.borderRadius = '12px';
        img.style.display = 'block';
        msgDiv.appendChild(img);
        msgDiv.innerHTML += timestampHTML;
        chatHistory.push(`${data.sender} [${timeStr}]: (Image)`);
    } else if (data.type === 'audio') {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = data.text; // The base64/blob string
        msgDiv.appendChild(audio);
        msgDiv.innerHTML += timestampHTML;
        chatHistory.push(`${data.sender} [${timeStr}]: (Voice Note)`);
    } else {
        msgDiv.innerHTML = `<div>${data.text}</div>${timestampHTML}`;
        chatHistory.push(`${data.sender} [${timeStr}]: ${data.text}`);
    }

    // Unread Count logic
    if (!isFocused && side === 'stranger') {
        unreadCount++;
        document.title = `(${unreadCount}) New Message!`;
    }

    // Attach reaction click event
    msgDiv.onclick = (e) => showReactionMenu(e, msgDiv);

    // Smart Auto-Scroll Calculation
    const threshold = 100; 
    const isAtBottom = (messagesDiv.scrollHeight - messagesDiv.clientHeight) <= (messagesDiv.scrollTop + threshold);

    messagesDiv.appendChild(msgDiv);

    if (isAtBottom) {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
}

/**
 * 4. MEDIA & FILE HANDLING
 */
document.getElementById('image-input').onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
            socket.emit('send-message', { 
                type: 'image', 
                text: ev.target.result 
            });
        };
        reader.readAsDataURL(file);
    }
};

/**
 * 4.5 VIDEO CALLING
 */
async function startVideoCall(isOfferer) {
    try {
        const overlay = document.getElementById('video-overlay');
        const localVid = document.getElementById('local-video');
        const remoteVid = document.getElementById('remote-video');
        
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        
        overlay.style.display = 'flex'; // Show the UI
        localVid.srcObject = localStream;

        peerConnection = new RTCPeerConnection(rtcConfig);
        
        // Add tracks
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        peerConnection.onicecandidate = (e) => {
            if (e.candidate) socket.emit('call-signal', { candidate: e.candidate });
        };

        peerConnection.ontrack = (e) => {
            remoteVid.srcObject = e.streams[0];
        };

        if (isOfferer) {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('call-signal', { sdp: offer });
        }
    } catch (err) {
        alert("Camera access denied.");
    }
}

const recordBtn = document.getElementById('record-btn'); // Create this in HTML

recordBtn.onclick = async () => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = () => {
            const blob = new Blob(audioChunks, { type: 'audio/ogg; codecs=opus' });
            const reader = new FileReader();
            reader.onload = (ev) => socket.emit('send-voice', { blob: ev.target.result });
            reader.readAsDataURL(blob);
        };

        mediaRecorder.start();
        recordBtn.innerText = "🛑 Stop";
    } else {
        mediaRecorder.stop();
        recordBtn.innerText = "🎤 Record";
    }
};

/**
 * 4.6 END CALL FUNCTION
 */
function endCall(notifyPartner = true) {
    const overlay = document.getElementById('video-overlay');
    
    // Stop all camera/mic tracks
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    
    // Close Peer Connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    overlay.style.display = 'none'; // Hide UI
    
    if (notifyPartner) {
        socket.emit('end-call');
    }
}

// Button listener
document.getElementById('end-call-btn').onclick = () => endCall(true);

// Socket listener for when the partner hangs up
socket.on('end-call', () => {
    alert("Partner ended the call.");
    endCall(false);
});

/**
 * 5. CHAT ACTIONS (Save, Leave, Report)
 */
document.getElementById('save-btn').onclick = () => {
    if (chatHistory.length === 0) return alert("No messages to save yet.");
    const logContent = chatHistory.join('\n');
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Promptly_History_${Date.now()}.txt`;
    link.click();
    URL.revokeObjectURL(url);
};

document.getElementById('leave-btn').onclick = () => {
    if (confirm("Are you sure you want to disconnect? The chat history will be lost unless saved.")) {
        location.reload();
    }
};

document.getElementById('report-btn').onclick = () => {
    if (confirm("Report this user for inappropriate behavior? This will end the chat.")) {
        alert("User reported. Thank you for keeping Promptly safe.");
        location.reload();
    }
};

document.getElementById('call-btn').onclick = () => {
    alert("Call request sent. Waiting for partner...");
    socket.emit('call-request');
};

/**
 * 6. CORE CHAT CONTROLS
 */
startBtn.onclick = () => {
    const name = document.getElementById('name-input').value.trim();
    const interests = document.getElementById('interests-input').value.trim();
    
    if (!name) return alert("Please enter your name first!");
    
    // PERSISTENCE: Save name for next refresh
    localStorage.setItem('Promptly-name', name);
    
    socket.emit('find-partner', { name, interests });
    
    startBtn.innerText = "Finding a partner...";
    startBtn.disabled = true;
};

// Typing indicator emission
msgInput.oninput = () => {
    socket.emit('typing');
};

const attemptSendMessage = () => {
    const text = msgInput.value.trim();
    if (text) {
        socket.emit('send-message', { type: 'text', text });
        msgInput.value = '';
    }
};

document.getElementById('send-btn').onclick = attemptSendMessage;
msgInput.onkeypress = (e) => { if (e.key === 'Enter') attemptSendMessage(); };

/**
 * 7. SOCKET LISTENERS
 */
socket.on('chat-started', (data) => {
    setupDiv.style.display = 'none';
    chatContainer.style.display = 'flex';

    // Explicitly set the name from the server, not localStorage
    partnerNameDisplay.innerText = data.name;
    console.log("Chat started with:", data.name);
    
    let startMsg = `--- Chat started with ${data.name} ---`;

    // Logic for displaying Shared Interests in the chat UI
    if (data.sharedInterests && data.sharedInterests.length > 0) {
        const interestText = data.sharedInterests.join(', ');
        const infoDiv = document.createElement('div');
        infoDiv.style.cssText = "text-align:center; font-size:0.8rem; margin:10px 0; opacity:0.7; color:var(--accent); font-weight:bold;";
        infoDiv.innerText = `You both like: ${interestText}`;
        messagesDiv.appendChild(infoDiv);
        
        // Add to history log string
        startMsg += ` (Shared interests: ${interestText})`;
    }

    chatHistory = [startMsg];
});

socket.on('receive-message', (data) => {
    addMessage(data);
});

socket.on('receive-reaction', (data) => {
    const targetMsg = document.getElementById(data.messageId);
    if (targetMsg) {
        applyReaction(targetMsg, data.emoji, true);
    }
});

socket.on('display-typing', () => {
    const partner = partnerNameDisplay.innerText;
    typingDiv.innerText = `${partner} is typing...`;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        typingDiv.innerText = '';
    }, 2000);
});

socket.on('partner-left', () => {
    alert("The stranger has disconnected.");
    location.reload();
});

socket.on('call-request', (data) => {
    const accept = confirm(`${data.from} wants to start a video call. Accept?`);
    if (accept) {
        socket.emit('call-response', { accepted: true });
        startVideoCall(false); // Start as the 'answerer'
    } else {
        socket.emit('call-response', { accepted: false });
    }
});

socket.on('call-response', (data) => {
    if (data.accepted) {
        startVideoCall(true); // Start as the 'offerer'
    } else {
        alert("Partner declined the call.");
    }
});

socket.on('call-signal', async (data) => {
    if (data.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('call-signal', { sdp: answer });
        }
    } else if (data.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
});

/**
 * 8. THEME & INITIALIZATION
 */
document.getElementById('theme-toggle').onclick = () => {
    const body = document.body;
    const currentTheme = body.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    body.setAttribute('data-theme', newTheme);
    document.getElementById('theme-toggle').innerText = newTheme === 'light' ? '☀️' : '🌙';
};

window.onload = () => {
    const nameInput = document.getElementById('name-input');
    const savedName = localStorage.getItem('Promptly-name');

    // Only restore saved name if the input is currently empty
    if (savedName && nameInput.value === "") {
        nameInput.value = savedName;
    }
};

// Emoji Bar functionality
document.querySelectorAll('#emoji-bar span').forEach(emojiSpan => {
    emojiSpan.onclick = () => {
        msgInput.value += emojiSpan.innerText;
        msgInput.focus();
    };
});