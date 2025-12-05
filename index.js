const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const app = express();
app.use(bodyParser.json());
app.use(cors());

const matches = {};
const players = {};

const endpoints = {
  "/health": (req,res)=> res.json({status:"ok", service:"SeaStrike Backend"}),

  "/player": (req,res)=>{
    const data = req.body;
    players[data.telegram_id] = data.username || "Player";
    res.json({
      telegram_id:data.telegram_id,
      username:data.username || "Player",
      rating:1000,
      skin_ship:"default",
      skin_board:"wood",
      frame:"none"
    });
  },

  "/match/random/join": (req,res)=>{
    const match_id = "demo-" + Math.floor(Math.random()*1000);
    matches[match_id] = {
      players:[req.body.telegram_id],
      turn:req.body.telegram_id,
      ships:{}
    };
    res.json({
      status:"matched",
      match_id,
      opponent_id:999999,
      is_your_turn:true
    });
  },

  "/match/:id/place-ships": (req,res)=>{
    const match = matches[req.params.id];
    if(match){
      match.ships[req.body.telegram_id] = req.body.ships;
      res.json({status:"ok"});
    }else res.status(404).json({error:"Not found"});
  },

  "/match/:id/wait-ready": (req,res)=>{
    const match = matches[req.params.id];
    if(match){
      res.json({status:"ready"});
    }else res.status(404).json({error:"Not found"});
  },

  "/match/:id/attack": (req,res)=>{
    const hit = Math.random()<0.3?2:Math.random()<0.6?1:0;
    const finished = hit===2 && Math.random()<0.1;
    res.json({
      hit,
      new_turn:999999,
      finished,
      winner_id:finished ? req.body.telegram_id : null
    });
  }
};

app.all("*", (req,res)=>{
  let path = req.path;
  for(let ep in endpoints){
    const regex = new RegExp("^"+ep.replace(":id","[^/]+")+"$");
    if(regex.test(path)) return endpoints[ep](req,res);
  }
  res.status(404).json({error:"Not found"});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log("Server running on port "+PORT));
