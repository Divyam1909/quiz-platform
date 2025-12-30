import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';
import pollData from './quiz.json';

// --- CONFIGURATION ---
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// --- HELPERS ---
const generateId = () => Math.random().toString(36).substr(2, 9);
const getSession = () => JSON.parse(sessionStorage.getItem('poll_session')) || {};
const setSession = (data) => sessionStorage.setItem('poll_session', JSON.stringify({ ...getSession(), ...data }));

// --- AVATARS (Cartoonistic animals) ---
const AVATARS = ['🐶', '🐱', '🐼', '🐨', '🦊', '🦁', '🐯', '🐸', '🐵', '🐔', '🐧', '🐦', '🦄', '🐙', '🦋', '🐢', '🦀', '🐬', '🦉', '🐝'];

// --- EMOJI OPTIONS ---
const REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '🤔', '👏'];

// --- COLORS ---
const Colors = ['#ef4444', '#3b82f6', '#eab308', '#22c55e'];
const ColorsBg = ['bg-red-500', 'bg-blue-500', 'bg-yellow-500', 'bg-green-500'];

// --- CONFETTI COMPONENT ---
function Confetti({ active }) {
    if (!active) return null;

    const confettiPieces = Array.from({ length: 50 }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 2,
        duration: 2 + Math.random() * 2,
        color: ['#ef4444', '#3b82f6', '#eab308', '#22c55e', '#ec4899', '#8b5cf6'][Math.floor(Math.random() * 6)]
    }));

    return (
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-50">
            {confettiPieces.map(piece => (
                <div
                    key={piece.id}
                    className="absolute w-3 h-3 animate-confetti"
                    style={{
                        left: `${piece.left}%`,
                        top: '-20px',
                        backgroundColor: piece.color,
                        animationDelay: `${piece.delay}s`,
                        animationDuration: `${piece.duration}s`,
                        transform: `rotate(${Math.random() * 360}deg)`
                    }}
                />
            ))}
            <style>{`
                @keyframes confetti {
                    0% { transform: translateY(0) rotate(0deg); opacity: 1; }
                    100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
                }
                .animate-confetti {
                    animation: confetti 3s ease-out forwards;
                }
            `}</style>
        </div>
    );
}

export default function App() {
    const [socket, setSocket] = useState(null);
    const [view, setView] = useState('LANDING');
    const [role, setRole] = useState(null);
    const [connectionError, setConnectionError] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    // Shared State
    const [roomCode, setRoomCode] = useState('');
    const [playerName, setPlayerName] = useState('');
    const [myId, setMyId] = useState(null);
    const [myAvatar, setMyAvatar] = useState(null);

    // Host State
    const [players, setPlayers] = useState([]);
    const [hostQuestion, setHostQuestion] = useState(null);
    const [liveVotes, setLiveVotes] = useState({ answersReceived: 0, totalPlayers: 0, voteData: [] });
    const [gameStatus, setGameStatus] = useState('LOBBY');
    const [timerDuration, setTimerDuration] = useState(0);
    const [timeRemaining, setTimeRemaining] = useState(0);
    const [emojiCounts, setEmojiCounts] = useState({});
    const [floatingEmojis, setFloatingEmojis] = useState([]);
    const [showConfetti, setShowConfetti] = useState(false);

    // Player State
    const [playerGameState, setPlayerGameState] = useState('WAITING');
    const [playerQuestion, setPlayerQuestion] = useState(null);
    const [myVote, setMyVote] = useState(null);
    const [sameOptionCount, setSameOptionCount] = useState(0);
    const [hasReacted, setHasReacted] = useState(false);

    // Helper: Vibrate on mobile
    const vibrate = (pattern = [50]) => {
        if (navigator.vibrate) navigator.vibrate(pattern);
    };

    // --- INITIALIZATION ---
    useEffect(() => {
        let storedId = localStorage.getItem('poll_player_id');
        if (!storedId) {
            storedId = generateId();
            localStorage.setItem('poll_player_id', storedId);
        }
        setMyId(storedId);

        const params = new URLSearchParams(window.location.search);
        const urlPin = params.get('pin');
        if (urlPin) setRoomCode(urlPin);

        const newSocket = io(BACKEND_URL, {
            transports: ['websocket', 'polling'],
            upgrade: true
        });
        setSocket(newSocket);

        newSocket.on('connect', () => {
            setConnectionError(false);
            const session = getSession();
            if (session.roomCode && session.role) {
                newSocket.emit('check_session', {
                    roomCode: session.roomCode,
                    type: session.role,
                    id: session.role === 'HOST' ? session.hostToken : storedId
                });
            }
        });

        newSocket.on('connect_error', () => setConnectionError(true));

        // Refresh confirmation to prevent accidental refreshes
        const handleBeforeUnload = (e) => {
            e.preventDefault();
            e.returnValue = 'Are you sure you want to refresh? You may lose your session.';
            return e.returnValue;
        };
        window.addEventListener('beforeunload', handleBeforeUnload);

        return () => {
            window.removeEventListener('beforeunload', handleBeforeUnload);
            newSocket.close();
        };
    }, []);

    useEffect(() => {
        if (!socket) return;

        socket.on('session_restored', (data) => {
            setRole(data.role);
            setRoomCode(data.roomCode);
            setGameStatus(data.gameState);

            if (data.role === 'HOST') {
                setView(data.gameState === 'LOBBY' ? 'HOST_LOBBY' : 'HOST_GAME');
                setPlayers(data.players || []);
                setTimerDuration(data.timerDuration || 0);
                if (data.emojiCounts) setEmojiCounts(data.emojiCounts);
            } else {
                setView('PLAYER_GAME');
                setPlayerName(data.playerName);
                setMyAvatar(data.avatar);
                if (data.gameState === 'QUESTION') {
                    setPlayerGameState(data.hasVoted ? 'SUBMITTED' : 'ANSWERING');
                    setPlayerQuestion(data.currentQuestion);
                    setTimeRemaining(data.timeRemaining || 0);
                } else if (data.gameState === 'LOBBY') {
                    setPlayerGameState('WAITING');
                } else if (data.gameState === 'OVER') {
                    setPlayerGameState('OVER');
                }
            }
        });

        socket.on('session_invalid', () => {
            sessionStorage.removeItem('poll_session');
            setView('LANDING');
        });

        socket.on('game_reset', () => {
            setGameStatus('LOBBY');
            setPlayerGameState('WAITING');
            setPlayerQuestion(null);
            setMyVote(null);
            setSameOptionCount(0);
            setHasReacted(false);
            setEmojiCounts({});
            setView(role === 'HOST' ? 'HOST_LOBBY' : 'PLAYER_GAME');
        });

        socket.on('room_closed', () => {
            alert("The host has ended the session.");
            sessionStorage.removeItem('poll_session');
            window.location.href = '/';
        });

        // --- HOST LISTENERS ---
        socket.on('player_joined', (updatedPlayers) => setPlayers(updatedPlayers));

        socket.on('new_question_host', (data) => {
            setHostQuestion(data);
            setGameStatus('QUESTION');
            setView('HOST_GAME');
            setLiveVotes({ answersReceived: 0, totalPlayers: players.length, voteData: data.voteData || [] });
            setEmojiCounts({});
            setTimeRemaining(data.timerDuration || 0);
        });

        socket.on('live_votes', (data) => setLiveVotes(data));

        socket.on('timer_tick', (time) => setTimeRemaining(time));

        socket.on('emoji_update', (data) => {
            setEmojiCounts(data.emojiCounts);
            // Add floating emoji animation
            const id = Date.now();
            setFloatingEmojis(prev => [...prev, { id, emoji: data.newEmoji }]);
            setTimeout(() => {
                setFloatingEmojis(prev => prev.filter(e => e.id !== id));
            }, 2000);
        });

        socket.on('poll_over', () => {
            setGameStatus('OVER');
            setPlayerGameState('OVER');
            setShowConfetti(true);
            setTimeout(() => setShowConfetti(false), 5000);
        });

        // --- PLAYER LISTENERS ---
        socket.on('new_question_player', (data) => {
            setPlayerQuestion(data);
            setPlayerGameState('ANSWERING');
            setMyVote(null);
            setSameOptionCount(0);
            setHasReacted(false);
            setTimeRemaining(data.timerDuration || 0);
        });

        socket.on('vote_received', (data) => {
            setPlayerGameState('SUBMITTED');
            setSameOptionCount(data.sameOptionCount || 0);
        });

        socket.on('emoji_received', () => setHasReacted(true));

    }, [socket, players.length, role]);

    // Timer countdown for players
    useEffect(() => {
        if (timerDuration > 0 && timeRemaining > 0 && playerGameState === 'ANSWERING') {
            const interval = setInterval(() => {
                setTimeRemaining(t => Math.max(0, t - 1));
            }, 1000);
            return () => clearInterval(interval);
        }
    }, [timerDuration, playerGameState]);

    // --- ACTIONS ---
    const handleCreatePoll = () => {
        const password = prompt("Enter admin password to host a poll:");
        if (password !== 'admin') {
            alert("Incorrect password. Only admins can host polls.");
            return;
        }

        // Ask for timer duration
        const timerOptions = ['No Timer (Manual)', '5 seconds', '10 seconds', '15 seconds', '20 seconds', '30 seconds', '45 seconds', '60 seconds'];
        const timerValues = [0, 5, 10, 15, 20, 30, 45, 60];

        let timerChoice = prompt(
            "Select timer duration for each question:\n\n" +
            "0 = No Timer (proceed manually)\n" +
            "5 = 5 seconds\n" +
            "10 = 10 seconds\n" +
            "15 = 15 seconds\n" +
            "20 = 20 seconds\n" +
            "30 = 30 seconds\n\n" +
            "Enter number (default: 0 for no timer):"
        );

        const selectedTimer = parseInt(timerChoice) || 0;
        setTimerDuration(selectedTimer);

        setIsLoading(true);
        vibrate([30]);
        socket.emit('create_room', { pollData, timerDuration: selectedTimer }, (response) => {
            setRoomCode(response.roomCode);
            setRole('HOST');
            setView('HOST_LOBBY');
            setPlayers([]);
            setSession({ role: 'HOST', roomCode: response.roomCode, hostToken: response.hostToken });
            setIsLoading(false);
        });
    };

    const handleStartGame = () => {
        if (socket) {
            vibrate([50, 50, 50]);
            socket.emit('start_game', roomCode);
        }
    };

    const handleNextQuestion = () => socket.emit('next_question', roomCode);
    const handleResetGame = () => socket.emit('reset_game', roomCode);

    const handleCloseRoom = () => {
        if (confirm("Are you sure you want to close the room for everyone?")) {
            socket.emit('close_room', roomCode);
        }
    };

    const handleJoinRoom = () => {
        if (!roomCode || !playerName) return alert("Please enter code and name");
        setIsLoading(true);
        vibrate([30]);
        socket.emit('join_room', { roomCode: roomCode.toUpperCase(), playerName, playerId: myId }, (response) => {
            if (response.error) {
                alert(response.error);
                vibrate([100, 50, 100]);
            } else {
                setRole('PLAYER');
                setView('PLAYER_GAME');
                setMyAvatar(response.avatar);
                setSession({ role: 'PLAYER', roomCode: roomCode.toUpperCase() });
                vibrate([50]);
            }
            setIsLoading(false);
        });
    };

    const handleSubmitVote = (index) => {
        if (playerGameState !== 'ANSWERING') return;
        if (myVote !== null) return;
        vibrate([100]);
        setMyVote(index);
        socket.emit('submit_vote', { roomCode, optionIndex: index, playerId: myId });
    };

    const handleSubmitEmoji = (emoji) => {
        if (hasReacted) return;
        socket.emit('submit_emoji', { roomCode, emoji, playerId: myId });
    };

    // --- VIEWS ---
    if (connectionError) return <div className="p-10 text-center text-red-600 font-bold">Connecting to server...</div>;

    if (view === 'LANDING') {
        return (
            <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white p-4 font-sans">
                <h1 className="text-6xl font-black mb-8 tracking-tighter transform -rotate-2">LIVE<span className="text-pink-500">POLL</span></h1>
                <div className="bg-slate-800 text-gray-100 p-8 rounded-2xl shadow-2xl w-full max-w-md space-y-6 border border-slate-700">
                    <div className="space-y-4">
                        <input
                            type="text"
                            placeholder="POLL PIN"
                            className="w-full text-center text-3xl p-4 border-b-4 border-slate-600 rounded-lg focus:border-pink-500 focus:outline-none uppercase tracking-[0.2em] font-black bg-slate-700 placeholder-slate-500"
                            value={roomCode}
                            onChange={e => setRoomCode(e.target.value)}
                            maxLength={6}
                        />
                        <input
                            type="text"
                            placeholder="Enter Nickname"
                            className="w-full text-center text-xl p-4 border-2 border-slate-600 rounded-lg focus:border-pink-500 focus:outline-none font-bold bg-slate-700"
                            value={playerName}
                            onChange={e => setPlayerName(e.target.value)}
                        />
                        <button onClick={handleJoinRoom} disabled={isLoading} className="w-full bg-pink-600 hover:bg-pink-500 disabled:bg-pink-900 disabled:cursor-not-allowed text-white font-black py-4 rounded-xl shadow-lg transform transition active:scale-95 text-xl flex items-center justify-center gap-2">
                            {isLoading && <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>}
                            {isLoading ? 'JOINING...' : 'JOIN POLL'}
                        </button>
                    </div>
                    <div className="border-t border-slate-700 pt-6 text-center">
                        <button onClick={handleCreatePoll} className="text-slate-400 hover:text-pink-400 font-bold text-sm underline">
                            Host a Poll
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (view === 'HOST_LOBBY') {
        const joinUrl = `${window.location.origin}?pin=${roomCode}`;
        return (
            <div className="min-h-screen bg-slate-900 text-white p-6 flex flex-col font-sans">
                <div className="flex flex-col md:flex-row justify-between items-center bg-slate-800 p-6 rounded-2xl shadow-xl mb-8 border border-slate-700">
                    <div>
                        <p className="text-slate-400 font-bold uppercase tracking-widest text-sm mb-2">Join at {window.location.hostname}</p>
                        <div className="flex items-center gap-4">
                            <div className="bg-pink-600 px-6 py-2 rounded-lg shadow-lg">
                                <span className="text-sm font-bold block text-pink-200 uppercase">Poll PIN</span>
                                <span className="text-5xl font-black tracking-widest font-mono">{roomCode}</span>
                            </div>
                            {timerDuration > 0 && (
                                <div className="bg-purple-600 px-4 py-2 rounded-lg">
                                    <span className="text-sm font-bold block text-purple-200">Timer</span>
                                    <span className="text-2xl font-black">{timerDuration}s</span>
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="mt-4 md:mt-0 bg-white p-3 rounded-xl shadow-inner">
                        <QRCodeSVG value={joinUrl} size={140} />
                    </div>
                </div>

                <div className="flex-1">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-3xl font-black flex items-center gap-3">
                            <span className="bg-green-500 text-white px-3 py-1 rounded-lg text-lg">{players.length}</span>
                            Waiting for Participants...
                        </h2>
                    </div>
                    {players.length === 0 ? (
                        <div className="text-center py-20 opacity-30 text-2xl font-bold italic">
                            Waiting for someone to join...
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                            {players.map((p, i) => (
                                <div key={i} className="bg-slate-800 text-white p-4 rounded-xl shadow-lg font-bold text-lg text-center transform transition hover:-translate-y-1 hover:shadow-2xl flex flex-col items-center justify-center min-h-[100px] border border-slate-700">
                                    <span className="text-3xl mb-2">{AVATARS[(p.avatar || 1) - 1]}</span>
                                    <span className="truncate w-full">{p.name}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="mt-8 sticky bottom-6">
                    <button
                        onClick={handleStartGame}
                        disabled={players.length === 0}
                        className={`w-full py-5 text-3xl font-black rounded-2xl shadow-2xl transition-all ${players.length > 0
                            ? 'bg-green-500 hover:bg-green-400 text-white transform hover:scale-[1.01] active:scale-[0.99]'
                            : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                            }`}
                    >
                        {players.length === 0 ? "Waiting for Participants..." : "START POLL 🚀"}
                    </button>
                    <div className="mt-4 text-center">
                        <button onClick={handleCloseRoom} className="text-red-500 font-bold text-sm underline hover:text-red-400">Close Room</button>
                    </div>
                </div>
            </div>
        );
    }

    if (view === 'HOST_GAME') {
        return (
            <>
                <Confetti active={showConfetti} />
                <HostGameView
                    status={gameStatus}
                    question={hostQuestion}
                    liveVotes={liveVotes}
                    onNext={handleNextQuestion}
                    onReset={handleResetGame}
                    onClose={handleCloseRoom}
                    roomCode={roomCode}
                    timerDuration={timerDuration}
                    timeRemaining={timeRemaining}
                    emojiCounts={emojiCounts}
                    floatingEmojis={floatingEmojis}
                    players={players}
                />
            </>
        );
    }

    if (view === 'PLAYER_GAME') {
        return (
            <>
                <Confetti active={showConfetti} />
                <PlayerGameView
                    state={gameStatus === 'OVER' ? 'OVER' : playerGameState}
                    question={playerQuestion}
                    onSubmit={handleSubmitVote}
                    myVote={myVote}
                    playerName={playerName}
                    avatar={myAvatar}
                    sameOptionCount={sameOptionCount}
                    timerDuration={timerDuration}
                    timeRemaining={timeRemaining}
                    hasReacted={hasReacted}
                    onEmojiSubmit={handleSubmitEmoji}
                />
            </>
        );
    }

    return <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">Loading...</div>;
}

// --- HOST GAME VIEW ---
function HostGameView({ status, question, liveVotes, onNext, onReset, onClose, roomCode, timerDuration, timeRemaining, emojiCounts, floatingEmojis, players }) {
    if (status === 'QUESTION') {
        const maxVotes = Math.max(...(liveVotes.voteData?.map(d => d.count) || [1]), 1);

        return (
            <div className="min-h-screen bg-slate-900 flex flex-col p-6 relative">
                {/* Floating Emojis */}
                {floatingEmojis.map(fe => (
                    <div
                        key={fe.id}
                        className="absolute text-4xl animate-float-up pointer-events-none"
                        style={{
                            left: `${20 + Math.random() * 60}%`,
                            bottom: '20%'
                        }}
                    >
                        {fe.emoji}
                    </div>
                ))}
                <style>{`
                    @keyframes float-up {
                        0% { transform: translateY(0) scale(1); opacity: 1; }
                        100% { transform: translateY(-200px) scale(1.5); opacity: 0; }
                    }
                    .animate-float-up {
                        animation: float-up 2s ease-out forwards;
                    }
                `}</style>

                {/* Header */}
                <div className="flex justify-between items-center mb-6">
                    <div className="text-white">
                        <span className="text-pink-500 font-mono text-2xl font-bold">{roomCode}</span>
                    </div>
                    <div className="text-white text-center flex items-center gap-4">
                        {timerDuration > 0 && (
                            <div className={`px-6 py-2 rounded-full font-black text-2xl ${timeRemaining <= 5 ? 'bg-red-600 animate-pulse' : 'bg-purple-600'}`}>
                                ⏱ {timeRemaining}s
                            </div>
                        )}
                        <span className="text-slate-400 text-sm uppercase tracking-wider">Responses</span>
                    </div>
                    {timerDuration === 0 && (
                        <button onClick={onNext} className="bg-pink-600 hover:bg-pink-500 text-white px-6 py-3 rounded-xl font-bold shadow-lg transition-all">
                            Next Question →
                        </button>
                    )}
                </div>

                {/* Question */}
                <div className="bg-slate-800 rounded-2xl p-8 mb-6 border border-slate-700">
                    <div className="flex justify-between items-center mb-4">
                        <span className="text-slate-400 font-bold">Q {question.questionIndex} / {question.totalQuestions}</span>
                        {/* Emoji Counter */}
                        {Object.keys(emojiCounts).length > 0 && (
                            <div className="flex gap-2">
                                {Object.entries(emojiCounts).map(([emoji, count]) => (
                                    <span key={emoji} className="bg-slate-700 px-3 py-1 rounded-full text-lg">
                                        {emoji} {count}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    <h2 className="text-4xl font-black text-white leading-tight">{question.question}</h2>
                </div>

                {/* Main Content */}
                <div className="flex flex-1 gap-6">
                    {/* Left: Circular Response Counter */}
                    <div className="w-48 flex flex-col items-center justify-center">
                        <div className="relative w-40 h-40">
                            <svg className="w-full h-full transform -rotate-90">
                                <circle cx="80" cy="80" r="70" fill="none" stroke="#334155" strokeWidth="12" />
                                <circle
                                    cx="80" cy="80" r="70"
                                    fill="none" stroke="#ec4899" strokeWidth="12" strokeLinecap="round"
                                    strokeDasharray={`${(liveVotes.answersReceived / Math.max(liveVotes.totalPlayers, 1)) * 440} 440`}
                                    className="transition-all duration-300"
                                />
                            </svg>
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                                <span className="text-5xl font-black">{liveVotes.answersReceived}</span>
                                <span className="text-slate-400 text-sm">/ {liveVotes.totalPlayers}</span>
                            </div>
                        </div>
                        <span className="text-pink-400 font-bold mt-4 text-lg">Responses</span>
                    </div>

                    {/* Right: Vote Distribution Bars */}
                    <div className="flex-1 flex flex-col justify-center space-y-4">
                        {liveVotes.voteData?.map((vote, idx) => (
                            <div key={idx} className="flex items-center gap-4">
                                <div className="w-48 flex-shrink-0">
                                    <span className="text-white font-bold text-lg truncate block">{vote.option}</span>
                                </div>
                                <div className="flex-1 h-12 bg-slate-700 rounded-lg overflow-hidden relative">
                                    <div
                                        className="h-full rounded-lg transition-all duration-500 ease-out flex items-center justify-end pr-4"
                                        style={{
                                            width: `${Math.max((vote.count / maxVotes) * 100, vote.count > 0 ? 10 : 0)}%`,
                                            backgroundColor: Colors[idx % Colors.length],
                                            minWidth: vote.count > 0 ? '60px' : '0'
                                        }}
                                    >
                                        {vote.count > 0 && (
                                            <span className="text-white font-black text-lg drop-shadow">{vote.count}</span>
                                        )}
                                    </div>
                                </div>
                                <div
                                    className="w-32 text-right px-4 py-2 rounded-full font-bold text-sm"
                                    style={{ backgroundColor: vote.count > 0 ? Colors[idx % Colors.length] : '#475569', color: 'white' }}
                                >
                                    {vote.count} Answered
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Participant Avatars Strip */}
                <div className="mt-6 flex items-center gap-2 overflow-x-auto pb-2">
                    <span className="text-slate-400 font-bold mr-2">Participants:</span>
                    {players.slice(0, 20).map((p, i) => (
                        <div key={i} className="flex-shrink-0 w-10 h-10 bg-slate-700 rounded-full flex items-center justify-center text-xl" title={p.name}>
                            {AVATARS[(p.avatar || 1) - 1]}
                        </div>
                    ))}
                    {players.length > 20 && (
                        <span className="text-slate-400 font-bold">+{players.length - 20} more</span>
                    )}
                </div>

                {/* Footer */}
                <div className="mt-4 bg-slate-800 p-4 rounded-xl border border-slate-700 flex justify-between items-center">
                    <div className="text-slate-400">
                        <span className="font-bold">Attempted: </span>
                        <span className="text-pink-400 font-black">{liveVotes.answersReceived}/{liveVotes.totalPlayers}</span>
                    </div>
                    <div className="text-slate-400">
                        <span className="font-bold">Unattempted: </span>
                        <span className="text-white font-black">{liveVotes.totalPlayers - liveVotes.answersReceived}</span>
                    </div>
                </div>
            </div>
        );
    }

    if (status === 'OVER') {
        return (
            <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white p-6">
                <div className="text-9xl mb-8">🎉</div>
                <h1 className="text-5xl font-black mb-8">Poll Complete!</h1>
                <div className="flex gap-4">
                    <button onClick={onReset} className="bg-pink-600 hover:bg-pink-500 text-white px-10 py-4 rounded-xl text-xl font-black shadow-lg">
                        New Poll 🔄
                    </button>
                    <button onClick={onClose} className="bg-red-600 hover:bg-red-500 text-white px-10 py-4 rounded-xl text-xl font-black shadow-lg">
                        End Session ❌
                    </button>
                </div>
            </div>
        );
    }

    return <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">Loading...</div>;
}

// --- PLAYER GAME VIEW ---
function PlayerGameView({ state, question, onSubmit, myVote, playerName, avatar, sameOptionCount, timerDuration, timeRemaining, hasReacted, onEmojiSubmit }) {
    if (state === 'WAITING') {
        return (
            <div className="min-h-screen bg-slate-800 flex flex-col items-center justify-center text-white p-6 text-center">
                <div className="text-7xl mb-4">{AVATARS[(avatar || 1) - 1]}</div>
                <h2 className="text-4xl font-black mb-4">You're in, {playerName}!</h2>
                <p className="text-xl text-slate-400">Watch the big screen...</p>
            </div>
        );
    }

    if (state === 'ANSWERING') {
        return (
            <div className="min-h-screen bg-slate-900 flex flex-col">
                <div className="bg-slate-800 p-4 shadow-md border-b border-slate-700">
                    <div className="flex justify-between items-center mb-2">
                        <span className="font-bold text-slate-400">Q{question.questionIndex}</span>
                        <div className="flex items-center gap-2">
                            {timerDuration > 0 && (
                                <span className={`px-4 py-1 rounded-full font-bold ${timeRemaining <= 5 ? 'bg-red-600 animate-pulse' : 'bg-purple-600'} text-white`}>
                                    {timeRemaining}s
                                </span>
                            )}
                            <span className="text-pink-400 font-bold">LIVE</span>
                        </div>
                    </div>
                    <h3 className="text-xl font-bold text-white leading-tight">{question.questionText}</h3>
                </div>

                <div className="flex-1 p-4 flex flex-col gap-3 overflow-y-auto justify-center">
                    {question.options.map((opt, idx) => (
                        <button
                            key={idx}
                            onClick={() => onSubmit(idx)}
                            className={`${ColorsBg[idx % ColorsBg.length]} rounded-xl shadow-md p-3 flex items-center active:scale-98 transition-all text-left group`}
                        >
                            <div className="bg-black bg-opacity-20 w-9 h-9 rounded-full flex items-center justify-center text-white mr-3 font-bold text-base flex-shrink-0 group-active:scale-110 transition-transform">
                                {idx === 0 ? '▲' : idx === 1 ? '●' : idx === 2 ? '■' : '★'}
                            </div>
                            <span className="text-white font-bold leading-tight">{opt}</span>
                        </button>
                    ))}
                </div>
            </div>
        );
    }

    if (state === 'SUBMITTED') {
        return (
            <div className="min-h-screen bg-gradient-to-b from-pink-600 to-purple-700 flex flex-col items-center justify-center text-white p-6 text-center">
                <div className="text-8xl mb-6">✅</div>
                <h2 className="text-4xl font-black mb-4">Vote Submitted!</h2>

                {sameOptionCount > 0 ? (
                    <div className="bg-white bg-opacity-20 px-8 py-4 rounded-2xl mt-4">
                        <p className="text-2xl font-bold">
                            <span className="text-5xl font-black text-yellow-300">{sameOptionCount}</span>
                            <span className="block mt-2">other{sameOptionCount > 1 ? 's' : ''} responded with the same option</span>
                        </p>
                    </div>
                ) : (
                    <p className="text-xl text-purple-200 mt-4">You're the first to choose this option!</p>
                )}

                {/* Emoji Reactions */}
                <div className="mt-8">
                    <p className="text-purple-200 mb-4 font-bold">React to this question:</p>
                    <div className="flex gap-3 justify-center">
                        {REACTION_EMOJIS.map(emoji => (
                            <button
                                key={emoji}
                                onClick={() => onEmojiSubmit(emoji)}
                                disabled={hasReacted}
                                className={`text-4xl p-3 rounded-xl transition-all ${hasReacted ? 'opacity-50 cursor-not-allowed' : 'bg-white bg-opacity-20 hover:bg-opacity-40 active:scale-110'}`}
                            >
                                {emoji}
                            </button>
                        ))}
                    </div>
                    {hasReacted && <p className="text-purple-200 mt-4 text-sm">Thanks for your reaction!</p>}
                </div>

                <p className="text-purple-200 mt-8 text-lg">Watch the big screen for results...</p>
            </div>
        );
    }

    if (state === 'OVER') {
        return (
            <div className="min-h-screen bg-gradient-to-b from-purple-700 to-slate-900 flex flex-col items-center justify-center text-white p-6 text-center">
                <div className="text-8xl mb-6">🎉</div>
                <h2 className="text-5xl font-black mb-4">Thanks for participating!</h2>
                <p className="text-xl text-purple-200">Poll has ended</p>
            </div>
        );
    }

    return <div className="min-h-screen bg-slate-900 text-white flex items-center justify-center">Loading...</div>;
}