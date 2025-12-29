import http from 'k6/http';
import { check, sleep } from 'k6';
import { WebSocket } from 'k6/experimental/websockets';
import { randomString, randomIntBetween } from 'k6';

// TEST CONFIGURATION
export const options = {
    stages: [
        { duration: '30s', target: 50 },   // Ramp up to 50 users
        { duration: '1m', target: 150 },   // Ramp up to 150 users
        { duration: '2m', target: 200 },   // Ramp up to 200 users (peak load)
        { duration: '2m', target: 200 },   // Stay at 200 users
        { duration: '30s', target: 0 },    // Ramp down to 0
    ],
    thresholds: {
        http_req_duration: ['p(95)<2000'], // 95% of requests should be below 2s
        http_req_failed: ['rate<0.01'],    // Less than 1% errors
        ws_connecting: ['avg<1000'],        // WebSocket connection time
        ws_msgs_received: ['count>0'],      // Should receive messages
    },
};

// ENVIRONMENT VARIABLES (configure these)
const BACKEND_URL = __ENV.BACKEND_URL || 'http://localhost:3001';
const FRONTEND_URL = __ENV.FRONTEND_URL || 'http://localhost:5173';

// Test data
let roomCode = null;
let playerIds = [];

export function setup() {
    console.log('🚀 Starting load test...');
    console.log(`Backend: ${BACKEND_URL}`);
    console.log(`Frontend: ${FRONTEND_URL}`);

    // Create a room for testing (this would be done by the host)
    // In reality, you'd start the host manually
    return {
        backendUrl: BACKEND_URL,
        frontendUrl: FRONTEND_URL,
    };
}

export default function (data) {
    const playerId = `player_${__VU}_${__ITER}_${randomString(8)}`;
    const playerName = `Player${__VU}`;

    // Simulate a player joining and playing the quiz
    simulatePlayer(data.backendUrl, playerId, playerName);

    sleep(randomIntBetween(1, 3)); // Random delay between actions
}

function simulatePlayer(backendUrl, playerId, playerName) {
    const wsUrl = backendUrl.replace('http', 'ws');

    const ws = new WebSocket(`${wsUrl}/socket.io/?EIO=4&transport=websocket`);

    ws.on('open', () => {
        console.log(`[${playerId}] Connected to server`);

        // Socket.io handshake
        ws.send('40'); // Socket.io connect packet

        // Simulate joining a room (assumes room code is known or provided)
        // In real test, you'd get this from the host
        const joinPayload = JSON.stringify([
            'join_room',
            {
                roomCode: 'TEST01', // You'll need to create this room first
                playerName: playerName,
                playerId: playerId
            }
        ]);

        ws.send(`42${joinPayload}`);
    });

    ws.on('message', (msg) => {
        console.log(`[${playerId}] Received: ${msg}`);

        // Handle different message types
        if (msg.includes('session_restored')) {
            console.log(`[${playerId}] Session restored`);
        }

        if (msg.includes('new_question_player')) {
            // Simulate answering after random delay
            setTimeout(() => {
                const answerIndex = randomIntBetween(0, 3);
                const submitPayload = JSON.stringify([
                    'submit_answer',
                    {
                        roomCode: 'TEST01',
                        answerIndex: answerIndex,
                        timeRemaining: randomIntBetween(1, 9),
                        playerId: playerId
                    }
                ]);
                ws.send(`42${submitPayload}`);
                console.log(`[${playerId}] Submitted answer: ${answerIndex}`);
            }, randomIntBetween(500, 3000));
        }
    });

    ws.on('error', (e) => {
        console.error(`[${playerId}] Error:`, e);
    });

    ws.on('close', () => {
        console.log(`[${playerId}] Disconnected`);
    });

    // Keep connection alive for the duration
    sleep(60); // Stay connected for 60 seconds

    ws.close();
}

export function teardown(data) {
    console.log('✅ Load test completed!');
}
