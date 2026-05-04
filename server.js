require('dotenv').config(); // MUST BE LINE 1
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GoogleGenAI } = require("@google/genai");

// Debugging check: this will print 'true' if the key loaded correctly
console.log("API Key loaded:", !!process.env.GOOGLE_API_KEY);

const ai = new GoogleGenAI({ 
    apiKey: process.env.GOOGLE_API_KEY // Ensure this variable name matches your .env file
});
const app = express();
const server = http.createServer(app);

/** 
 * Initialize Socket.io with a 10MB buffer. 
 * This is CRITICAL for the image-sharing feature to work without disconnecting.
 */
const io = new Server(server, { 
    maxHttpBufferSize: 1e7 
});

app.use(express.static(path.join(__dirname, 'public')));

// State management for matchmaking
let waitingUsers = [];
let rooms = {}; 
let users = {}; 

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    /**
     * FEATURE: Interest-Based Matching
     */
    socket.on('find-partner', (data) => {
        // Store user display name
        users[socket.id] = data.name || "Stranger";
        
        // Parse interests into a clean array
        const userInterests = data.interests 
            ? data.interests.toLowerCase().split(',').map(i => i.trim()).filter(i => i !== "") 
            : [];

        // Look for a partner with at least one matching interest
        let partnerIndex = waitingUsers.findIndex(u => 
            u.id !== socket.id && u.interests.some(i => userInterests.includes(i))
        );
        
        // Fallback: If no interest match, pick the person who has been waiting the longest
        if (partnerIndex === -1 && waitingUsers.length > 0) {
            partnerIndex = waitingUsers.findIndex(u => u.id !== socket.id);
        }

        if (partnerIndex !== -1) {
            // Match found! Remove them from the waiting queue
            const partner = waitingUsers.splice(partnerIndex, 1)[0];
            const roomId = `room-${socket.id}-${partner.id}`;
            
            socket.join(roomId);
            partner.socket.join(roomId);
            
            // Map both users to this room
            rooms[socket.id] = roomId;
            rooms[partner.id] = roomId;

            // NEW FUNCTION: Calculate shared interests to mention them in chat
            const shared = userInterests.filter(i => partner.interests.includes(i));
            
            // Notify both clients that the chat has started (Including shared interests)
            io.to(socket.id).emit('chat-started', { 
                name: users[partner.id], 
                sharedInterests: shared 
            });
            io.to(partner.id).emit('chat-started', { 
                name: users[socket.id], 
                sharedInterests: shared 
            });
            
            console.log(`Matched: ${users[socket.id]} and ${users[partner.id]}`);
        } else {
            // No match yet, add to queue
            const alreadyWaiting = waitingUsers.find(u => u.id === socket.id);
            if (!alreadyWaiting) {
                waitingUsers.push({ 
                    id: socket.id, 
                    socket: socket, 
                    interests: userInterests 
                });
            }
        }
    });

    /**
     * FEATURE: Messaging (Text & Images)
     */
    socket.on('send-message', async (data) => {
        const roomId = rooms[socket.id];
        if (!roomId) return;

        // 1. Send the original message to both users first
        socket.emit('receive-message', { 
            sender: 'Me', 
            type: data.type, 
            text: data.text 
        });
        socket.to(roomId).emit('receive-message', { 
            sender: users[socket.id], 
            type: data.type, 
            text: data.text 
        });

        // 2. AI Check: Only trigger if the message starts with @ai
        if (data.type === 'text' && data.text.toLowerCase().startsWith('@ai')) {
            const userQuery = data.text.slice(3).trim();
            try {
                const prompt = `You are CyberAI, a witty and objective fact-checker. 
                A user asked: "${userQuery}". 
                Provide a concise answer. 
                IMPORTANT: Do not use LaTeX. Use plain symbols like 'x' for multiplication, 
                '/' for division, and simple bolding for emphasis.`;
                
                // Use the simplified 2026 syntax
                const result = await ai.models.generateContent({
                    model: "gemini-3-flash-preview",
                    contents: prompt
                });

                // The text is a direct property in this version
                const aiResponse = result.text;

                io.to(roomId).emit('receive-message', {
                    sender: 'CyberAI ✨',
                    type: 'text',
                    text: aiResponse
                });
            } catch (error) {
                console.error("AI Call Error:", error.message);
            }
        }
    });

    /**
     * FEATURE: Reactions
     */
    socket.on('send-reaction', (data) => {
        const roomId = rooms[socket.id];
        if (roomId) {
            // Send the emoji to the partner
            socket.to(roomId).emit('receive-reaction', { 
                emoji: data.emoji 
            });
        }
    });

    /**
     * FEATURE: Typing Indicator
     */
    socket.on('typing', () => {
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.to(roomId).emit('display-typing');
        }
    });

    /**
     * FEATURE: WebRTC Signaling
     */
    // Handle the initial request to start a call
    socket.on('call-request', (data) => {
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.to(roomId).emit('call-request', { from: users[socket.id] });
        }
    });

    // Handle the partner's answer (Accept/Decline)
    socket.on('call-response', (data) => {
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.to(roomId).emit('call-response', { accepted: data.accepted });
        }
    });

    // Keep the existing signal relay for the actual connection data
    socket.on('call-signal', (data) => {
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.to(roomId).emit('call-signal', data);
        }
    });

    // Handle call ending
    socket.on('end-call', () => {
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.to(roomId).emit('end-call');
        }
    });

    /**
     * FEATURE: Voice Notes
     */
    socket.on('send-voice', (data) => {
        const roomId = rooms[socket.id];
        if (roomId) {
            socket.emit('receive-message', { sender: 'Me', type: 'audio', text: data.blob });
            socket.to(roomId).emit('receive-message', { sender: users[socket.id], type: 'audio', text: data.blob });
        }
    });

    /**
     * FEATURE: Cleanup on Disconnect
     */
    socket.on('disconnect', () => {
        const roomId = rooms[socket.id];
        if (roomId) {
            // Notify the partner that the stranger left
            socket.to(roomId).emit('partner-left');
            
            // Cleanup the room mapping for the other user
            // This prevents "phantom" messages in rooms that no longer exist
            const clients = io.sockets.adapter.rooms.get(roomId);
            if (clients) {
                for (const clientId of clients) {
                    delete rooms[clientId];
                }
            }
        }

        // Remove from waiting queue if they were still looking for a partner
        waitingUsers = waitingUsers.filter(u => u.id !== socket.id);
        
        // Clean up global user/room references
        delete users[socket.id];
        delete rooms[socket.id];
        
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});