const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const cors = require("cors");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*", // Enable CORS for all origins (Netlify frontend can connect)
    methods: ["GET", "POST"],
  },
});

app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ======================== GAME LOGIC ========================

/**
 * Card Deck Management
 */
function createDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];

  for (let suit of suits) {
    for (let rank of ranks) {
      deck.push({ suit, rank });
    }
  }

  return deck.sort(() => Math.random() - 0.5); // Shuffle
}

/**
 * Calculate hand score (Ace = 1 or 11)
 */
function calculateScore(hand) {
  let score = 0;
  let aces = 0;

  for (let card of hand) {
    if (card.rank === "A") {
      aces += 1;
      score += 11;
    } else if (["J", "Q", "K"].includes(card.rank)) {
      score += 10;
    } else {
      score += parseInt(card.rank);
    }
  }

  // Adjust for Aces
  while (score > 21 && aces > 0) {
    score -= 10;
    aces -= 1;
  }

  return score;
}

/**
 * Generate unique 5-character room code
 */
function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ======================== ROOM MANAGEMENT ========================

const rooms = new Map(); // Store rooms by code

class Room {
  constructor(code, ownerName, ownerId) {
    this.code = code;
    this.players = new Map();
    this.players.set(ownerId, {
      id: ownerId,
      name: ownerName,
      hand: [],
      score: 0,
      status: "waiting", // waiting, playing, stand, bust, blackjack, won, lost
      money: 1000,
      bet: 0,
    });
    this.deck = createDeck();
    this.dealerHand = [];
    this.dealerScore = 0;
    this.currentPlayerTurn = null;
    this.gameActive = false;
    this.roundActive = false;
  }

  addPlayer(playerId, playerName) {
    if (this.players.size >= 4) {
      return false; // Room full
    }
    if (this.players.has(playerId)) {
      return false; // Player already in room
    }

    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      hand: [],
      score: 0,
      status: "waiting",
      money: 1000,
      bet: 0,
    });
    return true;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    if (this.players.size === 0) {
      rooms.delete(this.code);
      return true; // Room is empty, delete it
    }
    return false;
  }

  resetRound() {
    this.dealerHand = [];
    this.dealerScore = 0;
    this.deck = createDeck();

    for (let player of this.players.values()) {
      player.hand = [];
      player.score = 0;
      player.status = "waiting";
      player.bet = 0;
    }

    this.currentPlayerTurn = null;
    this.roundActive = false;
  }

  dealInitialCards() {
    for (let player of this.players.values()) {
      player.hand.push(this.deck.pop());
      player.hand.push(this.deck.pop());
      player.score = calculateScore(player.hand);
    }

    this.dealerHand.push(this.deck.pop());
    this.dealerHand.push(this.deck.pop());
    this.dealerScore = calculateScore(this.dealerHand);
  }

  hitPlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;

    if (this.deck.length === 0) {
      this.deck = createDeck();
    }

    player.hand.push(this.deck.pop());
    player.score = calculateScore(player.hand);

    if (player.score > 21) {
      player.status = "bust";
    }

    return true;
  }

  standPlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;

    player.status = "stand";
    this.moveToNextPlayer();
    return true;
  }

  moveToNextPlayer() {
    const activePlayers = Array.from(this.players.values())
      .filter((p) => p.status !== "bust" && p.status !== "stand")
      .sort((a, b) => Array.from(this.players.keys()).indexOf(a.id) - Array.from(this.players.keys()).indexOf(b.id));

    if (activePlayers.length > 0) {
      this.currentPlayerTurn = activePlayers[0].id;
    } else {
      this.playDealerTurn();
    }
  }

  playDealerTurn() {
    while (this.dealerScore < 17 && this.deck.length > 0) {
      this.dealerHand.push(this.deck.pop());
      this.dealerScore = calculateScore(this.dealerHand);
    }

    this.determineWinners();
  }

  determineWinners() {
    const dealerBust = this.dealerScore > 21;

    for (let player of this.players.values()) {
      if (player.status === "bust") {
        player.status = "lost";
        player.money -= player.bet;
      } else if (dealerBust) {
        player.status = "won";
        player.money += player.bet;
      } else if (player.score > this.dealerScore) {
        player.status = "won";
        player.money += player.bet;
      } else if (player.score === this.dealerScore) {
        player.status = "push";
      } else {
        player.status = "lost";
        player.money -= player.bet;
      }
    }

    this.roundActive = false;
  }
}

// ======================== SOCKET.IO EVENTS ========================

io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Player creates a new room
  socket.on("create_room", (playerName) => {
    let roomCode;
    do {
      roomCode = generateRoomCode();
    } while (rooms.has(roomCode));

    const room = new Room(roomCode, playerName, socket.id);
    rooms.set(roomCode, room);
    socket.join(roomCode);

    socket.emit("room_created", {
      code: roomCode,
      players: Array.from(room.players.values()),
      message: `Room created! Code: ${roomCode}`,
    });

    console.log(`Room ${roomCode} created by ${playerName}`);
  });

  // Player joins an existing room
  socket.on("join_room", (data) => {
    const { code, playerName } = data;

    const room = rooms.get(code);
    if (!room) {
      socket.emit("join_error", { message: "Room not found!" });
      return;
    }

    if (!room.addPlayer(socket.id, playerName)) {
      socket.emit("join_error", { message: "Cannot join room (full or already joined)" });
      return;
    }

    socket.join(code);
    socket.emit("room_joined", {
      code: code,
      players: Array.from(room.players.values()),
      message: `Joined room ${code}!`,
    });

    io.to(code).emit("player_joined", {
      players: Array.from(room.players.values()),
      message: `${playerName} joined the game!`,
    });

    console.log(`${playerName} joined room ${code}`);
  });

  // Start the game
  socket.on("start_game", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.gameActive = true;
    room.roundActive = true;

    io.to(roomCode).emit("game_started", {
      players: Array.from(room.players.values()),
      message: "Game started! Place your bets.",
    });
  });

  // Place bet and deal initial cards
  socket.on("place_bet", (data) => {
    const { roomCode, bet } = data;
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    if (bet > player.money || bet <= 0) {
      socket.emit("bet_error", { message: "Invalid bet amount" });
      return;
    }

    player.bet = bet;
    player.status = "playing";

    // Check if all players have placed bets
    const allBetsPlaced = Array.from(room.players.values()).every((p) => p.bet > 0);

    if (allBetsPlaced) {
      room.dealInitialCards();
      room.currentPlayerTurn = Array.from(room.players.keys())[0];

      io.to(roomCode).emit("cards_dealt", {
        dealer: {
          hand: [room.dealerHand[0]], // Only show one dealer card
          score: calculateScore([room.dealerHand[0]]),
        },
        players: Array.from(room.players.values()),
        currentPlayerTurn: room.currentPlayerTurn,
        message: "Cards dealt! Player turns begin.",
      });

      console.log(`Round started in room ${roomCode}`);
    }
  });

  // Player hits
  socket.on("hit", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.currentPlayerTurn !== socket.id) return;

    room.hitPlayer(socket.id);
    const player = room.players.get(socket.id);

    io.to(roomCode).emit("player_hit", {
      playerId: socket.id,
      playerName: player.name,
      hand: player.hand,
      score: player.score,
      status: player.status,
      currentPlayerTurn: room.currentPlayerTurn,
    });

    if (player.status === "bust") {
      room.moveToNextPlayer();
      io.to(roomCode).emit("turn_updated", {
        currentPlayerTurn: room.currentPlayerTurn,
        players: Array.from(room.players.values()),
      });
    }
  });

  // Player stands
  socket.on("stand", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room || room.currentPlayerTurn !== socket.id) return;

    room.standPlayer(socket.id);
    const player = room.players.get(socket.id);

    io.to(roomCode).emit("player_stand", {
      playerId: socket.id,
      playerName: player.name,
      status: player.status,
      currentPlayerTurn: room.currentPlayerTurn,
    });

    io.to(roomCode).emit("turn_updated", {
      currentPlayerTurn: room.currentPlayerTurn,
      players: Array.from(room.players.values()),
    });
  });

  // Play again / reset round
  socket.on("play_again", (roomCode) => {
    const room = rooms.get(roomCode);
    if (!room) return;

    room.resetRound();

    io.to(roomCode).emit("round_reset", {
      players: Array.from(room.players.values()),
      message: "Round reset! Place your bets for the next round.",
    });
  });

  // Disconnect handling
  socket.on("disconnect", () => {
    console.log(`Client disconnected: ${socket.id}`);

    // Find and remove player from room
    for (let [roomCode, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        const playerName = room.players.get(socket.id).name;
        const isEmpty = room.removePlayer(socket.id);

        if (isEmpty) {
          console.log(`Room ${roomCode} deleted (empty)`);
        } else {
          io.to(roomCode).emit("player_left", {
            playerName: playerName,
            players: Array.from(room.players.values()),
            message: `${playerName} left the game!`,
          });
        }
      }
    }
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "Server is running" });
});

server.listen(PORT, () => {
  console.log(`🎰 Blackjack Server running on http://localhost:${PORT}`);
  console.log(`Socket.IO ready for connections...`);
});

// ======================== DEPLOYMENT NOTES ========================
/*
DEPLOYMENT GUIDE:

BACKEND (Render):
1. Push this /backend folder to GitHub
2. Go to https://render.com/
3. Create new "Web Service" from your GitHub repo
4. Set "Build Command": npm install
5. Set "Start Command": npm start
6. Set PORT environment variable: 3000
7. Deploy! You'll get a URL like: https://your-app.onrender.com

FRONTEND (Netlify):
1. Push /frontend folder to GitHub
2. Go to https://app.netlify.com/
3. Connect GitHub repo and select /frontend folder
4. Deploy!
5. In /frontend/client.js, replace:
   const BACKEND_URL = "http://localhost:3000"; 
   with the Render URL:
   const BACKEND_URL = "https://your-app.onrender.com";
6. Redeploy frontend to apply the change
*/
