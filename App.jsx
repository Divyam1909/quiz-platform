import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react'; // You may need to add this to package.json, or use image API fallback
import quizData from './quiz.json';

// --- CONFIGURATION ---
// REPLACE THIS WITH YOUR DEPLOYED RAILWAY SERVER URL
// For local testing, use 'http://localhost:3001'
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// --- ICONS & ASSETS ---
const Shapes = {
    0: (className) => <div className={`w-full h-full bg-red-500 clip-triangle ${className}`}>▲</div>,
    1: (className) => <div className={`w-full h-full bg-blue-500 ${className}`}>●</div>, // Circle
    2: (className) => <div className={`w-full h-full bg-yellow-500 ${className}`}>■</div>, // Square
    3: (className) => <div className={`w-full h-full bg-green-500 ${className}`}>★</div> // Star
};

const Colors = ['bg-red-500', 'bg-blue-500', 'bg-yellow-500', 'bg-green-500'];

// --- MAIN COMPONENT ---

export default function App() {
    const [socket, setSocket] = useState(null);
    const [view, setView] = useState('LANDING'); // LANDING, HOST_LOBBY, HOST_GAME, PLAYER_LOBBY, PLAYER_GAME
    const [role, setRole] = useState(null); // 'HOST' or 'PLAYER'
    const [connectionError, setConnectionError] = useState(false);

    // Shared State
    const [roomCode, setRoomCode] = useState('');
    const [playerName, setPlayerName] = useState('');

    // Host State
    const [players, setPlayers] = useState([]);
    const [hostQuestion, setHostQuestion] = useState(null);
    const [liveStats, setLiveStats] = useState({ answersReceived: 0, totalPlayers: 0 });
    const [leaderboard, setLeaderboard] = useState([]);
    const [gameStatus, setGameStatus] = useState('LOBBY'); // LOBBY, QUESTION, RESULT, LEADERBOARD, OVER

    // Player State
    const [playerGameState, setPlayerGameState] = useState('WAITING'); // WAITING, ANSWERING, SUBMITTED, RESULT
    const [playerQuestion, setPlayerQuestion] = useState(null);
    const [playerResult, setPlayerResult] = useState(null); // { correct: boolean, score: number }
    const [timer, setTimer] = useState(0);
    const [myAnswer, setMyAnswer] = useState(null); // Track what the player answered

    // Effects
    useEffect(() => {
        const newSocket = io(BACKEND_URL);
        setSocket(newSocket);

        newSocket.on('connect_error', () => {
            setConnectionError(true);
        });

        newSocket.on('connect', () => {
            setConnectionError(false);
        });

        return () => newSocket.close();
    }, []);

    useEffect(() => {
        if (!socket) return;

        // --- HOST LISTENERS ---
        socket.on('player_joined', (updatedPlayers) => {
            setPlayers(updatedPlayers);
        });

        socket.on('new_question_host', (data) => {
            setHostQuestion(data);
            setGameStatus('QUESTION');
            setLiveStats({ answersReceived: 0, totalPlayers: players.length });
        });

        socket.on('live_stats', (stats) => {
            setLiveStats(prev => ({ ...prev, ...stats }));
        });

        socket.on('question_ended', () => {
            setGameStatus('RESULT');
        });

        socket.on('show_leaderboard', (data) => {
            setLeaderboard(data);
            setGameStatus('LEADERBOARD');
        });

        socket.on('game_over', (finalLeaderboard) => {
            setLeaderboard(finalLeaderboard);
            setGameStatus('OVER');
        });

        // --- PLAYER LISTENERS ---
        socket.on('new_question_player', (data) => {
            setPlayerQuestion(data);
            setPlayerGameState('ANSWERING');
            setTimer(data.timeLimit);
            setMyAnswer(null); // Reset answer for new question
            setPlayerResult(null);
        });

        socket.on('answer_received', () => {
            setPlayerGameState('SUBMITTED');
        });

        socket.on('question_ended', (data) => {
            setPlayerGameState('RESULT');
            setPlayerResult(data); // Contains correctAnswer index
        });

    }, [socket, players.length]);

    // Timer Countdown Effect (Client side visual only)
    useEffect(() => {
        if (timer > 0 && playerGameState === 'ANSWERING') {
            const interval = setInterval(() => setTimer(t => t - 1), 1000);
            return () => clearInterval(interval);
        }
    }, [timer, playerGameState]);


    // --- HOST ACTIONS ---

    const handleCreateQuiz = () => {
        // Use imported quizData
        socket.emit('create_room', quizData, (response) => {
            setRoomCode(response.roomCode);
            setRole('HOST');
            setView('HOST_LOBBY');
            setPlayers([]);
        });
    };

    const handleStartGame = () => {
        socket.emit('start_game', roomCode);
    };

    const handleNextQuestion = () => {
        socket.emit('next_question', roomCode);
    };

    const handleShowLeaderboard = () => {
        socket.emit('show_leaderboard', roomCode);
    };

    // --- PLAYER ACTIONS ---

    const handleJoinRoom = () => {
        if (!roomCode || !playerName) return alert("Please enter code and name");

        socket.emit('join_room', { roomCode: roomCode.toUpperCase(), playerName }, (response) => {
            if (response.error) {
                alert(response.error);
            } else {
                setRole('PLAYER');
                setView('PLAYER_GAME');
            }
        });
    };

    const handleSubmitAnswer = (index) => {
        if (playerGameState !== 'ANSWERING') return;
        setMyAnswer(index); // Store locally
        socket.emit('submit_answer', {
            roomCode,
            answerIndex: index,
            timeRemaining: timer
        });
    };


    // --- RENDER HELPERS ---

    if (connectionError) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-red-50 text-red-800 p-4">
                <div className="text-center">
                    <h1 className="text-2xl font-bold mb-2">Connection Error</h1>
                    <p>Cannot connect to the backend at {BACKEND_URL}</p>
                    <p className="text-sm mt-2 text-gray-600">Ensure the backend server is running and the URL is correct.</p>
                </div>
            </div>
        );
    }

    // --- VIEWS ---

    if (view === 'LANDING') {
        return (
            <div className="min-h-screen bg-indigo-900 flex flex-col items-center justify-center text-white p-4 font-sans">
                <h1 className="text-5xl font-extrabold mb-8 tracking-tight">QUIZ<span className="text-yellow-400">MASTER</span></h1>

                <div className="bg-white text-gray-800 p-8 rounded-xl shadow-2xl w-full max-w-md space-y-6">
                    {/* Player Join Form */}
                    <div className="space-y-4">
                        <h2 className="text-xl font-bold text-center text-gray-700">Join a Game</h2>
                        <input
                            type="text"
                            placeholder="Game PIN"
                            className="w-full text-center text-2xl p-3 border-2 border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none uppercase tracking-widest font-bold"
                            value={roomCode}
                            onChange={e => setRoomCode(e.target.value)}
                            maxLength={6}
                        />
                        <input
                            type="text"
                            placeholder="Nickname"
                            className="w-full text-center text-xl p-3 border-2 border-gray-300 rounded-lg focus:border-indigo-500 focus:outline-none font-medium"
                            value={playerName}
                            onChange={e => setPlayerName(e.target.value)}
                        />
                        <button
                            onClick={handleJoinRoom}
                            className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-4 rounded-lg shadow-lg transform transition hover:scale-105"
                        >
                            Enter
                        </button>
                    </div>

                    <div className="border-t border-gray-200 pt-6">
                        <button
                            onClick={handleCreateQuiz}
                            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 rounded-lg text-sm"
                        >
                            Host a Quiz (from quiz.json)
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (view === 'HOST_LOBBY') {
        return (
            <div className="min-h-screen bg-indigo-800 text-white p-6 flex flex-col">
                <div className="flex justify-between items-start">
                    <div>
                        <p className="text-indigo-300 font-bold uppercase tracking-wider text-sm">Join at www.yoursite.com</p>
                        <div className="bg-white text-indigo-900 px-6 py-2 rounded-lg inline-block mt-2">
                            <span className="text-sm font-bold block text-gray-500">GAME PIN:</span>
                            <span className="text-5xl font-black tracking-widest">{roomCode}</span>
                        </div>
                    </div>
                    <div className="bg-white p-2 rounded-lg">
                        {/* Fallback QR if package missing */}
                        <img src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${roomCode}`} alt="QR Code" className="w-32 h-32" />
                    </div>
                </div>

                <div className="flex-1 mt-12">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-2xl font-bold">{players.length} Players Waiting...</h2>
                    </div>
                    <div className="flex flex-wrap gap-4">
                        {players.map((p, i) => (
                            <div key={i} className="bg-indigo-700 px-4 py-2 rounded-full font-bold animate-pulse">
                                {p.name}
                            </div>
                        ))}
                    </div>
                </div>

                <button
                    onClick={handleStartGame}
                    disabled={players.length === 0}
                    className={`w-full py-4 text-2xl font-bold rounded-lg shadow-xl mb-8 ${players.length > 0 ? 'bg-white text-indigo-900 hover:bg-gray-100' : 'bg-gray-500 text-gray-300 cursor-not-allowed'}`}
                >
                    Start Game
                </button>
            </div>
        );
    }

    if (view === 'HOST_GAME') {
        return ( // Placeholder for managing host game states
            <HostGameView
                status={gameStatus}
                question={hostQuestion}
                stats={liveStats}
                leaderboard={leaderboard}
                onNext={handleNextQuestion}
                onShowLeaderboard={handleShowLeaderboard}
            />
        );
    }

    // --- SUB-VIEWS FOR HOST GAME LOGIC ---
    function HostGameView({ status, question, stats, leaderboard, onNext, onShowLeaderboard }) {
        if (status === 'QUESTION') {
            return (
                <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4">
                    <div className="w-full max-w-5xl">
                        <div className="flex justify-between text-2xl font-bold text-gray-600 mb-4">
                            <span>{question.questionIndex} / {question.totalQuestions}</span>
                            <span className="text-purple-600">{question.timeLimit}s</span>
                        </div>

                        <div className="bg-white rounded-2xl shadow-xl p-12 text-center mb-8 min-h-[200px] flex items-center justify-center">
                            <h2 className="text-4xl font-bold text-gray-800">{question.question}</h2>
                        </div>

                        <div className="grid grid-cols-2 gap-4 mb-8">
                            {question.options.map((opt, idx) => (
                                <div key={idx} className={`${Colors[idx]} p-6 rounded-lg flex items-center shadow-md`}>
                                    <div className="bg-black bg-opacity-20 w-10 h-10 rounded-full flex items-center justify-center text-white mr-4 font-bold">
                                        {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                                    </div>
                                    <span className="text-white text-2xl font-bold">{opt}</span>
                                </div>
                            ))}
                        </div>

                        <div className="flex justify-between items-center">
                            <div className="text-xl font-bold text-gray-600">Answers: {stats.answersReceived} / {stats.totalPlayers}</div>
                            <div className="w-32 h-32 rounded-full border-8 border-purple-500 flex items-center justify-center text-3xl font-bold text-purple-700 bg-white">
                                {stats.answersReceived}
                            </div>
                        </div>
                    </div>
                </div>
            );
        }

        if (status === 'RESULT') {
            return (
                <div className="min-h-screen bg-indigo-900 flex flex-col items-center justify-center text-white p-4">
                    <h1 className="text-4xl font-bold mb-8">Time's Up!</h1>
                    <button onClick={onShowLeaderboard} className="bg-white text-indigo-900 px-8 py-4 rounded-xl text-2xl font-bold shadow-lg hover:bg-gray-100">
                        Show Leaderboard
                    </button>
                </div>
            );
        }

        if (status === 'LEADERBOARD' || status === 'OVER') {
            return (
                <div className="min-h-screen bg-purple-900 flex flex-col items-center p-8 text-white">
                    <h1 className="text-4xl font-bold mb-8">{status === 'OVER' ? 'FINAL SCORES' : 'Top Players'}</h1>
                    <div className="w-full max-w-2xl space-y-4">
                        {leaderboard.map((player, idx) => (
                            <div key={idx} className="bg-white text-purple-900 p-4 rounded-lg flex justify-between items-center shadow-lg transform transition hover:scale-105">
                                <div className="flex items-center">
                                    <span className="w-10 h-10 bg-purple-200 rounded-full flex items-center justify-center font-bold mr-4 text-purple-800">#{idx + 1}</span>
                                    <span className="font-bold text-xl">{player.name}</span>
                                </div>
                                <span className="font-black text-2xl">{player.score} pts</span>
                            </div>
                        ))}
                    </div>
                    <div className="mt-12">
                        {status !== 'OVER' && (
                            <button onClick={onNext} className="bg-green-500 px-8 py-3 rounded-lg text-xl font-bold shadow-lg">Next Question</button>
                        )}
                        {status === 'OVER' && (
                            <button onClick={() => window.location.reload()} className="bg-white text-purple-900 px-8 py-3 rounded-lg text-xl font-bold shadow-lg">New Game</button>
                        )}
                    </div>
                </div>
            );
        }

        return <div>Loading...</div>;
    }


    // --- PLAYER VIEW ---

    if (view === 'PLAYER_GAME') {
        if (playerGameState === 'WAITING') {
            return (
                <div className="min-h-screen bg-purple-600 flex flex-col items-center justify-center text-white p-4 text-center">
                    <div className="animate-bounce text-6xl mb-4">👀</div>
                    <h2 className="text-3xl font-bold mb-2">You're in!</h2>
                    <p className="text-xl opacity-80">See your name on screen?</p>
                    <div className="mt-8 bg-purple-800 px-6 py-2 rounded-full font-bold">{playerName}</div>
                </div>
            );
        }

        if (playerGameState === 'ANSWERING') {
            return (
                <div className="min-h-screen bg-gray-100 flex flex-col">
                    <div className="bg-purple-700 text-white p-4 text-center text-xl font-bold flex justify-between">
                        <span>Q{playerQuestion.questionIndex}</span>
                        <span>⏱ {timer}</span>
                    </div>
                    <div className="flex-1 grid grid-cols-2 gap-4 p-4">
                        {Array.from({ length: playerQuestion.optionsCount }).map((_, idx) => (
                            <button
                                key={idx}
                                onClick={() => handleSubmitAnswer(idx)}
                                className={`${Colors[idx]} rounded-xl shadow-lg flex items-center justify-center active:scale-95 transition-transform`}
                            >
                                <div className="text-white text-6xl shadow-sm">
                                    {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            );
        }

        if (playerGameState === 'SUBMITTED') {
            return (
                <div className="min-h-screen bg-indigo-600 flex flex-col items-center justify-center text-white p-4">
                    <div className="animate-pulse text-8xl mb-4">⏳</div>
                    <h2 className="text-3xl font-bold">Answer Sent!</h2>
                    <p className="opacity-80 mt-2">Wait for the result...</p>
                </div>
            );
        }

        if (playerGameState === 'RESULT') {
            const isCorrect = playerResult.correctAnswer === myAnswer;

            return (
                <div className={`min-h-screen flex flex-col items-center justify-center text-white p-4 text-center ${isCorrect ? 'bg-green-500' : 'bg-red-500'}`}>
                    <div className="text-8xl mb-4">{isCorrect ? '✓' : '✗'}</div>
                    <h2 className="text-5xl font-bold mb-4">{isCorrect ? 'Correct!' : 'Incorrect'}</h2>
                    {isCorrect ? (
                        <p className="text-2xl">+ Points</p>
                    ) : (
                        <p className="text-2xl">Better luck next time!</p>
                    )}
                </div>
            );
        }
    }

    return <div>Loading App...</div>;
}