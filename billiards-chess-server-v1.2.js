const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 8080);
const HTML_FILE = path.join(__dirname, 'billiards-chess-v1.2.html');

const MAX_ROOMS = 10;
const MAX_CLIENTS_PER_ROOM = 10;
const MAX_PLAYERS_PER_ROOM = 2;

// 管理端总开关。
// 每个房间自己的换位权限默认关闭，由当前执棋者控制。
const ALLOW_SWAP_REQUESTS =
  String(
    process.env.ALLOW_SWAP_REQUESTS || 'true'
  ).toLowerCase() !== 'false';

let nextClientId = 1;
let nextRequestId = 1;


/* =========================================================
   房间默认统一设置
   ========================================================= */

const DEFAULT_ROOM_SETTINGS = Object.freeze({
  pieceSizeScale: 0.62,

  knightPassEnabled: true,

  knightPassRadiusCells: 1.5,

  customWeightEnabled: false,

  customWeight: {
    P: 1,
    N: 3,
    B: 3,
    R: 5,
    Q: 9,
    K: 15
  },

  pawnCaptureAngleDeg: 22.5,

  pieceCaptureAngleDeg: 22.5,

  clockEnabled: true,

  clockMode: 'total',

  totalTimeMs:
    15 * 60 * 1000,

  moveTimeMs:
    30 * 1000
});


/* =========================================================
   设置合法化
   ========================================================= */

function sanitizeRoomSettings(input) {
  const x =
    input &&
    typeof input === 'object'
      ? input
      : {};

  const weights =
    x.customWeight &&
    typeof x.customWeight === 'object'
      ? x.customWeight
      : {};

  const num = (
    value,
    min,
    max,
    fallback
  ) => {

    const n =
      Number(value);

    if (
      !Number.isFinite(n)
    ) {
      return fallback;
    }

    return Math.max(
      min,
      Math.min(max, n)
    );
  };


  return {

    pieceSizeScale:
      num(
        x.pieceSizeScale,
        0.2,
        1,
        DEFAULT_ROOM_SETTINGS
          .pieceSizeScale
      ),


    knightPassEnabled:
      x.knightPassEnabled !== false,


    knightPassRadiusCells:
      num(
        x.knightPassRadiusCells,
        0,
        3,
        DEFAULT_ROOM_SETTINGS
          .knightPassRadiusCells
      ),


    customWeightEnabled:
      x.customWeightEnabled === true,


    customWeight: {

      P:
        num(
          weights.P,
          0.1,
          100,
          1
        ),

      N:
        num(
          weights.N,
          0.1,
          100,
          3
        ),

      B:
        num(
          weights.B,
          0.1,
          100,
          3
        ),

      R:
        num(
          weights.R,
          0.1,
          100,
          5
        ),

      Q:
        num(
          weights.Q,
          0.1,
          100,
          9
        ),

      K:
        num(
          weights.K,
          0.1,
          100,
          15
        )
    },


    pawnCaptureAngleDeg:
      num(
        x.pawnCaptureAngleDeg,
        0,
        45,
        DEFAULT_ROOM_SETTINGS
          .pawnCaptureAngleDeg
      ),


    pieceCaptureAngleDeg:
      num(
        x.pieceCaptureAngleDeg,
        0,
        45,
        DEFAULT_ROOM_SETTINGS
          .pieceCaptureAngleDeg
      ),


    clockEnabled:
      x.clockEnabled !== false,


    clockMode:
      x.clockMode === 'move'
        ? 'move'
        : 'total',


    totalTimeMs:
      num(
        x.totalTimeMs,
        60 * 1000,
        180 * 60 * 1000,
        DEFAULT_ROOM_SETTINGS
          .totalTimeMs
      ),


    moveTimeMs:
      num(
        x.moveTimeMs,
        5 * 1000,
        600 * 1000,
        DEFAULT_ROOM_SETTINGS
          .moveTimeMs
      )
  };
}


function settingsEqual(a, b) {
  return (
    JSON.stringify(a) ===
    JSON.stringify(b)
  );
}


/* =========================================================
   房间
   ========================================================= */

function createRoom(id) {
  return {

    id,

    name:
      `房间 ${id}`,

    clients:
      new Set(),

    hostId:
      null,

    players: {

      white:
        null,

      black:
        null
    },

    pendingSwaps:
      new Map(),

    // 默认关闭。
    swapEnabled:
      false,

    // 最新完整棋盘状态。
    state:
      null,

    // 房间统一规则。
    settings:
      sanitizeRoomSettings(
        DEFAULT_ROOM_SETTINGS
      ),

    // 第一次成功出手后锁定。
    gameStarted:
      false
  };
}


const rooms =
  new Map();


for (
  let i = 1;
  i <= MAX_ROOMS;
  i++
) {

  rooms.set(
    String(i),
    createRoom(i)
  );
}


/* =========================================================
   HTTP
   ========================================================= */

const server =
  http.createServer(
    (req, res) => {

      const url =
        new URL(
          req.url,
          `http://${
            req.headers.host ||
            'localhost'
          }`
        );


      /* ---------------------------------------------------
         /health
         --------------------------------------------------- */

      if (
        url.pathname ===
        '/health'
      ) {

        res.writeHead(
          200,
          {
            'Content-Type':
              'application/json; charset=utf-8',

            'Cache-Control':
              'no-cache'
          }
        );


        res.end(
          JSON.stringify({

            ok:
              true,

            service:
              'billiards-chess-relay',

            version:
              '1.2',

            author:
              'bilibili：Kasuunfisble',

            rooms:
              MAX_ROOMS,

            maxClientsPerRoom:
              MAX_CLIENTS_PER_ROOM,

            swapRequestsEnabled:
              ALLOW_SWAP_REQUESTS,

            swapPermission:
              'player-controlled-default-off'
          })
        );


        return;
      }


      /* ---------------------------------------------------
         /rooms

         房间大厅 HTTP 接口。
         --------------------------------------------------- */

      if (
        url.pathname ===
        '/rooms'
      ) {

        res.writeHead(
          200,
          {
            'Content-Type':
              'application/json; charset=utf-8',

            'Cache-Control':
              'no-store'
          }
        );


        res.end(
          JSON.stringify({

            ok:
              true,

            version:
              '1.2',

            rooms:
              roomList(),

            swapRequestsEnabled:
              ALLOW_SWAP_REQUESTS
          })
        );


        return;
      }


      /* ---------------------------------------------------
         游戏页面
         --------------------------------------------------- */

      if (
        url.pathname === '/' ||
        url.pathname === '/index.html'
      ) {

        fs.readFile(
          HTML_FILE,
          (err, data) => {

            if (err) {

              res.writeHead(
                500,
                {
                  'Content-Type':
                    'text/plain; charset=utf-8'
                }
              );


              res.end(
                'HTML file not found'
              );


              return;
            }


            res.writeHead(
              200,
              {
                'Content-Type':
                  'text/html; charset=utf-8',

                'Cache-Control':
                  'no-cache'
              }
            );


            res.end(data);
          }
        );


        return;
      }


      res.writeHead(
        404,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );


      res.end(
        'Not found'
      );
    }
  );


const wss =
  new WebSocketServer({
    server
  });


/* =========================================================
   基础函数
   ========================================================= */

function send(ws, obj) {

  if (
    ws &&
    ws.readyState === 1
  ) {

    ws.send(
      JSON.stringify(obj)
    );
  }
}


function broadcast(
  room,
  obj,
  except = null
) {

  for (
    const ws of room.clients
  ) {

    if (
      ws !== except
    ) {

      send(
        ws,
        obj
      );
    }
  }
}


function broadcastAll(obj) {

  for (
    const ws of wss.clients
  ) {

    send(
      ws,
      obj
    );
  }
}


function playerCount(room) {

  return (
    Number(
      !!room.players.white
    ) +
    Number(
      !!room.players.black
    )
  );
}


function participantList(room) {

  return [
    ...room.clients
  ].map(
    ws => ({

      id:
        ws.clientId,

      name:
        ws.name ||
        '玩家',

      role:
        ws.role ||
        null,

      mode:
        ws.mode ||
        'spectator'
    })
  );
}


/* =========================================================
   房间列表
   ========================================================= */

function roomList() {

  return [
    ...rooms.values()
  ].map(
    room => ({

      id:
        room.id,

      name:
        room.name,

      count:
        room.clients.size,

      capacity:
        MAX_CLIENTS_PER_ROOM,

      players:
        playerCount(room),

      spectators:
        Math.max(
          0,
          room.clients.size -
          playerCount(room)
        ),

      whiteName:
        room.players.white
          ? (
              room.players.white.name ||
              '玩家'
            )
          : '',

      blackName:
        room.players.black
          ? (
              room.players.black.name ||
              '玩家'
            )
          : '',

      swapEnabled:
        ALLOW_SWAP_REQUESTS &&
        room.swapEnabled
    })
  );
}


function sendRoomList() {

  broadcastAll({

    type:
      'room-list',

    rooms:
      roomList(),

    swapRequestsEnabled:
      ALLOW_SWAP_REQUESTS
  });
}


function sendRoomUpdate(room) {

  broadcast(
    room,
    {

      type:
        'room-update',

      room:
        String(room.id),

      roomName:
        room.name,

      count:
        room.clients.size,

      capacity:
        MAX_CLIENTS_PER_ROOM,

      participants:
        participantList(room),

      swapRequestsEnabled:
        ALLOW_SWAP_REQUESTS,

      swapEnabled:
        ALLOW_SWAP_REQUESTS &&
        room.swapEnabled,

      state:
        room.state,

      // ★ 房间统一设置
      roomSettings:
        room.settings,

      gameStarted:
        room.gameStarted
    }
  );


  sendRoomList();
}


/* =========================================================
   换位请求清理
   ========================================================= */

function clearSwapRequests(
  room,
  predicate = () => true
) {

  for (
    const [requestId, req]
    of room.pendingSwaps
  ) {

    if (
      predicate(req)
    ) {

      room.pendingSwaps.delete(
        requestId
      );
    }
  }
}


/* =========================================================
   找客户端
   ========================================================= */

function findClient(
  room,
  clientId
) {

  for (
    const ws of room.clients
  ) {

    if (
      ws.clientId ===
      clientId
    ) {

      return ws;
    }
  }


  return null;
}


/* =========================================================
   玩家分配
   ========================================================= */

function assignFirstPlayer(
  room,
  ws,
  requestedRole
) {

  let role =
    requestedRole;


  if (
    role !== 'white' &&
    role !== 'black' &&
    role !== 'random'
  ) {

    role =
      'white';
  }


  if (
    role === 'random'
  ) {

    role =
      Math.random() < 0.5
        ? 'white'
        : 'black';
  }


  room.players[role] =
    ws;


  ws.role =
    role;


  ws.mode =
    'player';
}


function assignSecondPlayer(
  room,
  ws
) {

  const role =
    room.players.white
      ? 'black'
      : 'white';


  room.players[role] =
    ws;


  ws.role =
    role;


  ws.mode =
    'player';
}


function assignNextOpenPlayer(
  room,
  ws
) {

  if (
    !room.players.white
  ) {

    room.players.white =
      ws;

    ws.role =
      'white';

    ws.mode =
      'player';

    return true;
  }


  if (
    !room.players.black
  ) {

    room.players.black =
      ws;

    ws.role =
      'black';

    ws.mode =
      'player';

    return true;
  }


  return false;
}


function promoteSpectator(room) {

  if (
    playerCount(room) >=
    MAX_PLAYERS_PER_ROOM
  ) {

    return null;
  }


  const candidate =
    [
      ...room.clients
    ].find(
      ws =>
        ws.mode ===
        'spectator'
    );


  if (!candidate) {
    return null;
  }


  assignNextOpenPlayer(
    room,
    candidate
  );


  return candidate;
}


/* =========================================================
   房主
   ========================================================= */

function currentHost(room) {

  return room.hostId
    ? findClient(
        room,
        room.hostId
      )
    : null;
}


function pickNewHost(room) {

  const current =
    currentHost(room);


  if (current) {
    return current;
  }


  const first =
    room.clients
      .values()
      .next()
      .value ||
    null;


  room.hostId =
    first
      ? first.clientId
      : null;


  return first;
}


/* =========================================================
   WebSocket
   ========================================================= */

wss.on(
  'connection',
  ws => {

    ws.clientId =
      `c${nextClientId++}`;


    ws.room =
      null;


    ws.role =
      null;


    ws.mode =
      'spectator';


    ws.name =
      '玩家';


    ws.isAlive =
      true;


    send(
      ws,
      {

        type:
          'room-list',

        rooms:
          roomList(),

        swapRequestsEnabled:
          ALLOW_SWAP_REQUESTS
      }
    );


    ws.on(
      'pong',
      () => {

        ws.isAlive =
          true;
      }
    );


    ws.on(
      'message',
      raw => {

        let msg;


        try {

          msg =
            JSON.parse(
              raw.toString()
            );

        } catch {

          send(
            ws,
            {
              type:
                'error',

              message:
                '消息格式无效'
            }
          );


          return;
        }


        /* ===============================================
           加入房间
           =============================================== */

        if (
          msg.type ===
          'join'
        ) {

          if (
            ws.room
          ) {

            send(
              ws,
              {
                type:
                  'error',

                message:
                  '你已经在房间内'
              }
            );


            return;
          }


          const roomId =
            String(
              msg.room ||
              '1'
            );


          const room =
            rooms.get(
              roomId
            );


          if (!room) {

            send(
              ws,
              {
                type:
                  'error',

                message:
                  '房间号必须为 1～10'
              }
            );


            return;
          }


          if (
            room.clients.size >=
            MAX_CLIENTS_PER_ROOM
          ) {

            send(
              ws,
              {
                type:
                  'room-full',

                message:
                  '该房间已满（最多10人）'
              }
            );


            return;
          }


          ws.name =
            String(
              msg.name ||
              '玩家'
            )
              .trim()
              .slice(
                0,
                16
              ) ||
            '玩家';


          const wasEmpty =
            room.clients.size ===
            0;


          const requestedRole =
            String(
              msg.requestedRole ||
              'white'
            );


          /*
           * 第一个玩家进入空房间：
           * 使用其本地当前规则作为房间初始规则。
           */

          if (
            wasEmpty
          ) {

            room.settings =
              sanitizeRoomSettings(
                msg.initialSettings ||
                DEFAULT_ROOM_SETTINGS
              );


            room.gameStarted =
              false;


            room.state =
              null;
          }


          /*
           * 分配席位。
           */

          if (
            playerCount(room) ===
            0
          ) {

            assignFirstPlayer(
              room,
              ws,
              requestedRole
            );

          } else if (
            playerCount(room) ===
            1
          ) {

            assignSecondPlayer(
              room,
              ws
            );

          } else {

            ws.role =
              null;

            ws.mode =
              'spectator';
          }


          room.clients.add(
            ws
          );


          ws.room =
            roomId;


          if (
            wasEmpty
          ) {

            room.hostId =
              ws.clientId;

          } else {

            pickNewHost(
              room
            );
          }


          /*
           * 给刚加入的客户端：
           * 当前角色、房间设置、游戏状态。
           */

          send(
            ws,
            {

              type:
                'joined',

              clientId:
                ws.clientId,

              room:
                roomId,

              roomName:
                room.name,

              role:
                ws.role,

              mode:
                ws.mode,

              host:
                ws.clientId ===
                room.hostId,

              canChooseStartRole:
                wasEmpty,

              players:
                playerCount(room),

              count:
                room.clients.size,

              capacity:
                MAX_CLIENTS_PER_ROOM,

              participants:
                participantList(room),

              state:
                room.state,

              swapRequestsEnabled:
                ALLOW_SWAP_REQUESTS,

              swapEnabled:
                ALLOW_SWAP_REQUESTS &&
                room.swapEnabled,

              // ★ 房间统一设置
              roomSettings:
                room.settings,

              gameStarted:
                room.gameStarted
            }
          );


          /*
           * 第二位执棋者进入：
           * 要求房主把完整棋盘状态
           * 定向发给新加入者。
           */

          if (
            ws.mode === 'player' &&
            playerCount(room) === 2
          ) {

            const host =
              currentHost(room);


            if (
              host &&
              host !== ws
            ) {

              send(
                host,
                {

                  type:
                    'peer-joined',

                  room:
                    roomId,

                  players:
                    playerCount(room),

                  count:
                    room.clients.size
                }
              );


              send(
                host,
                {

                  type:
                    'request-state',

                  room:
                    roomId,

                  requesterId:
                    ws.clientId
                }
              );
            }
          }


          /*
           * 旁观者直接得到服务器缓存状态。
           */

          if (
            ws.mode ===
              'spectator' &&

            room.state
          ) {

            send(
              ws,
              {

                type:
                  'state',

                room:
                  roomId,

                state:
                  room.state,

                roomSettings:
                  room.settings
              }
            );
          }


          sendRoomUpdate(
            room
          );


          return;
        }


        /* ===============================================
           未进入房间
           =============================================== */

        if (
          !ws.room
        ) {

          if (
            msg.type ===
            'room-list'
          ) {

            send(
              ws,
              {

                type:
                  'room-list',

                rooms:
                  roomList(),

                swapRequestsEnabled:
                  ALLOW_SWAP_REQUESTS
              }
            );
          }


          return;
        }


        const room =
          rooms.get(
            ws.room
          );


        if (
          !room ||
          !room.clients.has(ws)
        ) {

          return;
        }


        /* ===============================================
           请求状态
           =============================================== */

        if (
          msg.type ===
          'request-state'
        ) {

          const host =
            currentHost(room) ||
            room.players.white ||
            room.players.black;


          if (
            host
          ) {

            send(
              host,
              {

                type:
                  'request-state',

                room:
                  ws.room,

                requesterId:
                  ws.clientId
              }
            );

          } else if (
            room.state
          ) {

            send(
              ws,
              {

                type:
                  'state',

                room:
                  ws.room,

                state:
                  room.state,

                roomSettings:
                  room.settings
              }
            );
          }


          return;
        }


        /* ===============================================
           房间改名
           =============================================== */

        if (
          msg.type ===
          'rename-room'
        ) {

          const name =
            String(
              msg.name ||
              ''
            )
              .trim()
              .slice(
                0,
                24
              );


          room.name =
            name ||
            `房间 ${room.id}`;


          broadcast(
            room,
            {

              type:
                'room-renamed',

              room:
                ws.room,

              roomName:
                room.name,

              by:
                ws.clientId
            }
          );


          sendRoomList();


          return;
        }


        /* ===============================================
           ★ 房间统一规则设置
           =============================================== */

        if (
          msg.type ===
          'set-room-settings'
        ) {

          /*
           * 只有执棋者可以修改。
           */

          if (
            ws.mode !==
            'player'
          ) {

            send(
              ws,
              {

                type:
                  'room-settings-rejected',

                message:
                  '只有执棋者可以修改房间统一规则'
              }
            );


            return;
          }


          /*
           * 第一次出手后服务器锁定。
           */

          if (
            room.gameStarted
          ) {

            send(
              ws,
              {

                type:
                  'room-settings-rejected',

                message:
                  '本局已经开始，房间统一规则已锁定'
              }
            );


            return;
          }


          const settings =
            sanitizeRoomSettings(
              msg.settings
            );


          /*
           * 相同设置无需重复广播。
           */

          if (
            settingsEqual(
              settings,
              room.settings
            )
          ) {

            send(
              ws,
              {

                type:
                  'room-settings',

                room:
                  ws.room,

                settings:
                  room.settings,

                by:
                  ws.clientId,

                byName:
                  ws.name
              }
            );


            return;
          }


          room.settings =
            settings;


          /*
           * 广播给包括修改者在内的
           * 全部房间客户端。
           */

          broadcast(
            room,
            {

              type:
                'room-settings',

              room:
                ws.room,

              settings:
                room.settings,

              by:
                ws.clientId,

              byName:
                ws.name
            }
          );


          /*
           * 房间大厅也同步。
           */

          sendRoomUpdate(
            room
          );


          return;
        }


        /* ===============================================
           换位权限
           =============================================== */

        if (
          msg.type ===
          'set-swap-enabled'
        ) {

          if (
            !ALLOW_SWAP_REQUESTS
          ) {

            send(
              ws,
              {

                type:
                  'swap-disabled',

                message:
                  '服务器已关闭换位请求功能'
              }
            );


            return;
          }


          if (
            ws.mode !==
            'player'
          ) {

            send(
              ws,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '只有执棋者可以修改换位权限'
              }
            );


            return;
          }


          const enabled =
            msg.enabled ===
            true;


          room.swapEnabled =
            enabled;


          if (
            !enabled
          ) {

            clearSwapRequests(
              room
            );
          }


          broadcast(
            room,
            {

              type:
                'swap-state',

              room:
                ws.room,

              enabled:
                room.swapEnabled,

              participants:
                participantList(
                  room
                ),

              by:
                ws.clientId,

              message:
                `${ws.name} 已将房间换位${
                  room.swapEnabled
                    ? '开启'
                    : '关闭'
                }`
            }
          );


          sendRoomUpdate(
            room
          );


          return;
        }


        /* ===============================================
           换位请求
           =============================================== */

        if (
          msg.type ===
          'swap-request'
        ) {

          if (
            !ALLOW_SWAP_REQUESTS ||
            !room.swapEnabled
          ) {

            send(
              ws,
              {

                type:
                  'swap-disabled',

                message:
                  !ALLOW_SWAP_REQUESTS
                    ? '服务器已关闭换位请求'
                    : '本房间换位目前由执棋者关闭'
              }
            );


            return;
          }


          const target =
            findClient(
              room,
              String(
                msg.targetId ||
                ''
              )
            );


          if (
            !target ||
            target === ws
          ) {

            send(
              ws,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '换位目标不存在'
              }
            );


            return;
          }


          if (
            !target.role &&
            !ws.role
          ) {

            send(
              ws,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '旁观者之间不能换位'
              }
            );


            return;
          }


          clearSwapRequests(
            room,
            req =>
              req.fromId ===
              ws.clientId
          );


          const requestId =
            `s${nextRequestId++}`;


          const req = {

            requestId,

            fromId:
              ws.clientId,

            toId:
              target.clientId,

            fromName:
              ws.name,

            fromRole:
              ws.role,

            toName:
              target.name,

            createdAt:
              Date.now()
          };


          room.pendingSwaps.set(
            requestId,
            req
          );


          send(
            ws,
            {

              type:
                'swap-pending',

              requestId,

              message:
                '换位请求已发送，等待对方处理'
            }
          );


          send(
            target,
            {

              type:
                'swap-offer',

              requestId,

              fromId:
                ws.clientId,

              fromName:
                ws.name,

              fromRole:
                ws.role,

              message:
                `${ws.name} 请求与你换位`
            }
          );


          return;
        }


        /* ===============================================
           换位接受 / 拒绝
           =============================================== */

        if (
          msg.type ===
          'swap-response'
        ) {

          if (
            !ALLOW_SWAP_REQUESTS ||
            !room.swapEnabled
          ) {

            send(
              ws,
              {

                type:
                  'swap-disabled',

                message:
                  !ALLOW_SWAP_REQUESTS
                    ? '服务器已关闭换位请求'
                    : '本房间换位目前由执棋者关闭'
              }
            );


            return;
          }


          const requestId =
            String(
              msg.requestId ||
              ''
            );


          const req =
            room.pendingSwaps.get(
              requestId
            );


          if (
            !req ||
            req.toId !==
            ws.clientId
          ) {

            send(
              ws,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '换位请求已失效'
              }
            );


            return;
          }


          room.pendingSwaps.delete(
            requestId
          );


          const requester =
            findClient(
              room,
              req.fromId
            );


          if (!requester) {

            send(
              ws,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '请求方已离开房间'
              }
            );


            return;
          }


          if (
            !msg.accept
          ) {

            send(
              requester,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  `${ws.name} 拒绝了换位请求`
              }
            );


            send(
              ws,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '已拒绝换位请求'
              }
            );


            return;
          }


          const requesterRole =
            requester.role;


          const targetRole =
            ws.role;


          if (
            requesterRole ===
            'white'
          ) {

            room.players.white =
              null;
          }


          if (
            requesterRole ===
            'black'
          ) {

            room.players.black =
              null;
          }


          if (
            targetRole ===
            'white'
          ) {

            room.players.white =
              null;
          }


          if (
            targetRole ===
            'black'
          ) {

            room.players.black =
              null;
          }


          requester.role =
            targetRole ||
            null;


          ws.role =
            requesterRole ||
            null;


          requester.mode =
            requester.role
              ? 'player'
              : 'spectator';


          ws.mode =
            ws.role
              ? 'player'
              : 'spectator';


          if (
            requester.role ===
            'white'
          ) {

            room.players.white =
              requester;
          }


          if (
            requester.role ===
            'black'
          ) {

            room.players.black =
              requester;
          }


          if (
            ws.role ===
            'white'
          ) {

            room.players.white =
              ws;
          }


          if (
            ws.role ===
            'black'
          ) {

            room.players.black =
              ws;
          }


          clearSwapRequests(
            room,
            r =>
              r.fromId ===
                requester.clientId ||

              r.toId ===
                requester.clientId ||

              r.fromId ===
                ws.clientId ||

              r.toId ===
                ws.clientId
          );


          send(
            requester,
            {

              type:
                'swap-result',

              ok:
                true,

              role:
                requester.role,

              mode:
                requester.mode,

              message:
                '换位成功'
            }
          );


          send(
            ws,
            {

              type:
                'swap-result',

              ok:
                true,

              role:
                ws.role,

              mode:
                ws.mode,

              message:
                '换位成功'
            }
          );


          sendRoomUpdate(
            room
          );


          return;
        }


        /* ===============================================
           游戏消息
           =============================================== */

        const relayTypes =
          new Set([
            'shot',
            'state',
            'restart',
            'timeout',
            'castle'
          ]);


        if (
          relayTypes.has(
            msg.type
          )
        ) {

          msg.room =
            ws.room;


          /*
           * 游戏操作必须由执棋者发送。
           */

          if (
            msg.type ===
              'shot' ||

            msg.type ===
              'castle' ||

            msg.type ===
              'restart' ||

            msg.type ===
              'timeout'
          ) {

            if (
              ws.mode !==
              'player'
            ) {

              return;
            }


            msg.actorRole =
              ws.role ||
              null;
          }


          /*
           * 保存 state。
           */

          if (
            msg.type ===
              'state' &&

            ws.mode ===
              'player' &&

            typeof msg.state ===
              'string'
          ) {

            room.state =
              msg.state;


            /*
             * 从客户端状态同步
             * 开局锁定状态。
             */

            try {

              const parsed =
                JSON.parse(
                  msg.state
                );


              room.gameStarted =
                parsed.gameStarted ===
                true;

            } catch {}
          }


          /*
           * 一旦有真正的游戏操作，
           * 房间规则锁定。
           */

          if (
            msg.type ===
              'shot' ||

            msg.type ===
              'castle' ||

            msg.type ===
              'timeout'
          ) {

            room.gameStarted =
              true;
          }


          /*
           * restart 会解除规则锁定。
           */

          if (
            msg.type ===
              'restart'
          ) {

            room.gameStarted =
              false;
          }


          /*
           * 如果收到 restart state，
           * 同样保存最新棋盘。
           */

          if (
            msg.type ===
              'restart' &&

            typeof msg.state ===
              'string'
          ) {

            room.state =
              msg.state;


            try {

              const parsed =
                JSON.parse(
                  msg.state
                );


              room.gameStarted =
                parsed.gameStarted ===
                true;

            } catch {}
          }


          /*
           * 定向 state。
           */

          if (
            msg.type ===
              'state' &&

            msg.to
          ) {

            const target =
              findClient(
                room,
                String(
                  msg.to
                )
              );


            if (
              target
            ) {

              send(
                target,
                msg
              );
            }

          } else {

            /*
             * 普通游戏消息发送给
             * 其他房间成员。
             */

            broadcast(
              room,
              msg,
              ws
            );
          }


          if (
            msg.type ===
              'state' ||

            msg.type ===
              'restart'
          ) {

            sendRoomList();
          }


          return;
        }
      });


  /* =======================================================
     断开连接
     ======================================================= */

  ws.on(
    'close',
    () => {

      const roomId =
        ws.room;


      if (!roomId) {
        return;
      }


      const room =
        rooms.get(
          roomId
        );


      if (!room) {
        return;
      }


      const wasPlayer =
        ws.mode ===
        'player';


      /*
       * 立即从房间删除。
       */

      room.clients.delete(
        ws
      );


      /*
       * 清理旧换位请求。
       */

      clearSwapRequests(
        room,
        req =>
          req.fromId ===
            ws.clientId ||

          req.toId ===
            ws.clientId
      );


      /*
       * 房主离开。
       */

      if (
        room.hostId ===
        ws.clientId
      ) {

        room.hostId =
          null;
      }


      /*
       * 如果是执棋者离开，
       * 释放他的执棋席位。
       */

      if (
        wasPlayer
      ) {

        if (
          ws.role ===
            'white' &&

          room.players.white ===
            ws
        ) {

          room.players.white =
            null;
        }


        if (
          ws.role ===
            'black' &&

          room.players.black ===
            ws
        ) {

          room.players.black =
            null;
        }


        /*
         * 执棋席位变化后，
         * 换位重新关闭。
         */

        room.swapEnabled =
          false;


        clearSwapRequests(
          room
        );


        ws.role =
          null;

        ws.mode =
          'spectator';
      }


      /*
       * 房间彻底没人：
       * 房间恢复默认状态。
       */

      if (
        room.clients.size ===
        0
      ) {

        room.name =
          `房间 ${room.id}`;


        room.hostId =
          null;


        room.players.white =
          null;


        room.players.black =
          null;


        room.pendingSwaps.clear();


        room.swapEnabled =
          false;


        room.state =
          null;


        room.settings =
          sanitizeRoomSettings(
            DEFAULT_ROOM_SETTINGS
          );


        room.gameStarted =
          false;


        /*
         * 立即通知大厅。
         */

        sendRoomList();


        return;
      }


      /*
       * 重新选房主。
       */

      pickNewHost(
        room
      );


      /*
       * 有空缺执棋位时，
       * 自动提升最早旁观者。
       */

      const promoted =
        wasPlayer
          ? promoteSpectator(room)
          : null;


      broadcast(
        room,
        {

          type:
            'peer-left',

          room:
            roomId,

          count:
            room.clients.size,

          promotedClientId:
            promoted
              ? promoted.clientId
              : null,

          promotedRole:
            promoted
              ? promoted.role
              : null,

          participants:
            participantList(room),

          roomSettings:
            room.settings
        }
      );


      if (
        promoted
      ) {

        send(
          promoted,
          {

            type:
              'role-changed',

            clientId:
              promoted.clientId,

            role:
              promoted.role,

            mode:
              promoted.mode,

            participants:
              participantList(room),

            message:
              `你已自动接替${
                promoted.role ===
                'white'
                  ? '白方'
                  : '黑方'
              }`
          }
        );


        if (
          room.state
        ) {

          send(
            promoted,
            {

              type:
                'state',

              room:
                roomId,

              state:
                room.state,

              roomSettings:
                room.settings
            }
          );
        }
      }


      /*
       * 最终广播完整房间状态。
       *
       * 此时白方/黑方名称已经是最新。
       */

      sendRoomUpdate(
        room
      );
    }
  );
});


/* =========================================================
   心跳
   ========================================================= */

const heartbeat =
  setInterval(
    () => {

      for (
        const ws of wss.clients
      ) {

        if (
          ws.isAlive ===
          false
        ) {

          ws.terminate();

          continue;
        }


        ws.isAlive =
          false;


        try {

          ws.ping();

        } catch {}
      }

    },
    30000
  );


/* =========================================================
   换位请求自动过期
   ========================================================= */

const swapCleanup =
  setInterval(
    () => {

      const now =
        Date.now();


      for (
        const room
        of rooms.values()
      ) {

        for (
          const [id, req]
          of room.pendingSwaps
        ) {

          if (
            now -
              req.createdAt >
            60000
          ) {

            room.pendingSwaps.delete(
              id
            );


            const requester =
              findClient(
                room,
                req.fromId
              );


            const target =
              findClient(
                room,
                req.toId
              );


            send(
              requester,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '换位请求已超时'
              }
            );


            send(
              target,
              {

                type:
                  'swap-result',

                ok:
                  false,

                message:
                  '换位请求已超时'
              }
            );
          }
        }
      }

    },
    10000
  );


/* =========================================================
   关闭服务器
   ========================================================= */

function shutdown() {

  clearInterval(
    heartbeat
  );

  clearInterval(
    swapCleanup
  );


  server.close(
    () =>
      process.exit(0)
  );
}


process.on(
  'SIGTERM',
  shutdown
);


process.on(
  'SIGINT',
  shutdown
);


/* =========================================================
   启动
   ========================================================= */

server.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');

    console.log(
      'billiards-chess v1.2'
    );

    console.log(
      'Author: bilibili：Kasuunfisble'
    );

    console.log(
      `rooms=${MAX_ROOMS} | ` +
      `capacity=${MAX_CLIENTS_PER_ROOM} | ` +
      `swapRequests=${ALLOW_SWAP_REQUESTS}`
    );


    console.log(
      `本机页面:      http://127.0.0.1:${PORT}`
    );


    console.log(
      `本机房间状态:  http://127.0.0.1:${PORT}/rooms`
    );


    console.log(
      `本机WebSocket: ws://127.0.0.1:${PORT}`
    );


    console.log(
      '局域网设备必须使用 HTTP + WS（不要使用 HTTPS + WSS）：'
    );


    const nets =
      os.networkInterfaces();


    const ips =
      [];


    for (
      const entries
      of Object.values(nets)
    ) {

      for (
        const net
        of entries || []
      ) {

        if (
          net &&
          net.family ===
            'IPv4' &&

          !net.internal
        ) {

          ips.push(
            net.address
          );
        }
      }
    }


    for (
      const ip
      of [
        ...new Set(ips)
      ]
    ) {

      console.log(
        `  页面:      http://${ip}:${PORT}`
      );


      console.log(
        `  房间状态:  http://${ip}:${PORT}/rooms`
      );


      console.log(
        `  WebSocket: ws://${ip}:${PORT}`
      );
    }


    console.log(
      `监听: http://0.0.0.0:${PORT}`
    );


    console.log('');
  }
);
