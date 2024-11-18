import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, Socket } from 'socket.io-client';
import { GameGateway } from '../src/game/game.gateway';
import { GameService } from '../src/game/service/game.service';
import socketEvents from '../src/common/constants/socket-events';
import { Redis } from 'ioredis';
import { GameValidator } from '../src/game/validations/game.validator';
import { GameChatService } from '../src/game/service/game.chat.service';
import { GameRoomService } from '../src/game/service/game.room.service';
import { HttpService } from '@nestjs/axios';
import { mockQuizData } from './mocks/quiz-data.mock';
import RedisMock from 'ioredis-mock';
import { REDIS_KEY } from '../src/common/constants/redis-key.constant';
import { QuizCacheService } from '../src/game/service/quiz.cache.service';
import { QuizService } from '../src/quiz/quiz.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QuizSetModel } from '../src/quiz/entities/quiz-set.entity';
import { QuizModel } from '../src/quiz/entities/quiz.entity';
import { QuizChoiceModel } from '../src/quiz/entities/quiz-choice.entity';
import { UserModel } from '../src/user/entities/user.entity';
import { UserQuizArchiveModel } from '../src/user/entities/user-quiz-archive.entity';
import { ConfigModule } from '@nestjs/config';

const mockHttpService = {
  axiosRef: jest.fn().mockImplementation(() => {
    return Promise.resolve({
      data: mockQuizData,
      status: 200
    });
  })
};

describe('GameGateway (e2e)', () => {
  let app: INestApplication;
  let client1: Socket;
  let client2: Socket;
  let client3: Socket;
  let redisMock: Redis;

  const TEST_PORT = 3001;

  beforeAll(async () => {
    /* ioredis-mock을 사용하여 테스트용 인메모리 Redis 생성 */
    redisMock = new RedisMock();
    jest.spyOn(redisMock, 'config').mockImplementation(() => Promise.resolve('OK'));

    // hset 메소드 오버라이드
    const originalHset = redisMock.hmset.bind(redisMock);
    redisMock.hmset = async function (key: string, ...args: any[]) {
      const result = await originalHset(key, ...args);

      await this.publish(`__keyspace@0__:${key}`, 'hset');

      return result;
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        // RedisModule.forRoot({
        //   type: 'single',
        //   url: 'redis://localhost:6379'
        // }),
        ConfigModule.forRoot({
          envFilePath: '../.env',
          isGlobal: true
        }),
        TypeOrmModule.forRoot({
          type: 'mysql',
          host: process.env.DB_HOST_TEST || process.env.DB_HOST || '127.0.0.1',
          port: +process.env.DB_PORT_TEST || +process.env.DB_PORT || 3306,
          username: process.env.DB_USER_TEST || process.env.DB_USER || 'root',
          password: process.env.DB_PASSWD_TEST || process.env.DB_PASSWD || 'test',
          database: process.env.DB_NAME_TEST || process.env.DB_NAME || 'test_db',
          entities: [QuizSetModel, QuizModel, QuizChoiceModel, UserModel, UserQuizArchiveModel],
          synchronize: true // test모드에서는 항상 활성화
        }),
        TypeOrmModule.forFeature([QuizSetModel, QuizModel, QuizChoiceModel, UserModel])
      ],
      providers: [
        GameGateway,
        GameService,
        GameChatService,
        GameRoomService,
        GameValidator,
        QuizCacheService,
        QuizService,
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: redisMock
        },
        {
          provide: HttpService,
          useValue: mockHttpService
        }
      ]
    }).compile();

    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(TEST_PORT);
  });

  beforeEach(async () => {
    await redisMock.flushall();

    return new Promise<void>((resolve) => {
      let connectedClients = 0;
      const onConnect = () => {
        connectedClients++;
        if (connectedClients === 3) {
          resolve();
        }
      };

      client1 = io(`http://localhost:${TEST_PORT}/game`, {
        transports: ['websocket'],
        forceNew: true
      });
      client2 = io(`http://localhost:${TEST_PORT}/game`, {
        transports: ['websocket'],
        forceNew: true
      });
      client3 = io(`http://localhost:${TEST_PORT}/game`, {
        transports: ['websocket'],
        forceNew: true
      });

      client1.on('connect', onConnect);
      client2.on('connect', onConnect);
      client3.on('connect', onConnect);
    });
  });

  afterEach(async () => {
    if (client1 && client1.connected) {
      client1.disconnect();
    }
    if (client2 && client2.connected) {
      client2.disconnect();
    }
    if (client3 && client3.connected) {
      client3.disconnect();
    }
    await redisMock.flushall();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('createRoom 이벤트 테스트', () => {
    it('유효한 설정으로 게임방 생성 성공', async () => {
      const gameConfig = {
        title: 'hello world!',
        gameMode: 'RANKING',
        maxPlayerCount: 2,
        isPublicGame: true
      };

      const response = await new Promise<{ gameId: string }>((resolve) => {
        client1.once(socketEvents.CREATE_ROOM, resolve);
        client1.emit(socketEvents.CREATE_ROOM, gameConfig);
      });

      expect(response.gameId).toBeDefined();
      expect(typeof response.gameId).toBe('string');

      // 실제 Redis 저장 확인
      const roomData = await redisMock.hgetall(`Room:${response.gameId}`);
      expect(roomData).toBeDefined();
      expect(roomData.title).toBe(gameConfig.title);
      expect(roomData.gameMode).toBe(gameConfig.gameMode);
      expect(roomData.maxPlayerCount).toBe(gameConfig.maxPlayerCount.toString());
    });

    const invalidConfigs = [
      {
        case: '빈 title',
        config: { title: '', gameMode: 'RANKING', maxPlayerCount: 2, isPublicGame: true }
      },
      {
        case: '빈 gameMode',
        config: { title: 'hello', gameMode: '', maxPlayerCount: 2, isPublicGame: true }
      },
      {
        case: '잘못된 gameMode',
        config: { title: 'hello', gameMode: 'invalid', maxPlayerCount: 2, isPublicGame: true }
      },
      {
        case: '최소 인원 미달',
        config: { title: 'hello', gameMode: 'RANKING', maxPlayerCount: 0, isPublicGame: true }
      }
    ];

    invalidConfigs.forEach(({ case: testCase, config }) => {
      it(`${testCase}인 경우 에러 발생`, (done) => {
        client1.once('exception', (error) => {
          expect(error).toBeDefined();
          expect(error.eventName).toBe(socketEvents.CREATE_ROOM);
          done();
        });

        client1.emit(socketEvents.CREATE_ROOM, config);
      });
    });
  });

  describe('joinRoom 이벤트 테스트', () => {
    it('존재하는 방 참여 성공', async () => {
      // 방 생성
      const createResponse = await new Promise<{ gameId: string }>((resolve) => {
        client1.once(socketEvents.CREATE_ROOM, resolve);
        client1.emit(socketEvents.CREATE_ROOM, {
          title: 'Test Room',
          gameMode: 'RANKING',
          maxPlayerCount: 5,
          isPublicGame: true
        });
      });

      // 방 참여
      const joinResponse = await new Promise<any>((resolve) => {
        client2.once(socketEvents.JOIN_ROOM, resolve);
        client2.emit(socketEvents.JOIN_ROOM, {
          gameId: createResponse.gameId,
          playerName: 'TestPlayer'
        });
      });

      expect(joinResponse.players).toBeDefined();

      // Redis에서 플레이어 정보 확인
      const playerData = await redisMock.hgetall(`Player:${client2.id}`);
      expect(playerData).toBeDefined();
      expect(playerData.playerName).toBe('TestPlayer');
    });

    it('존재하지 않는 방 참여 실패', (done) => {
      client1.once('exception', (error) => {
        expect(error.eventName).toBe('joinRoom');
        expect(error.message).toBe('존재하지 않는 게임 방입니다.');
        done();
      });

      client1.emit(socketEvents.JOIN_ROOM, {
        gameId: '999999',
        playerName: 'TestPlayer'
      });
    });
  });

  describe('chatMessage 이벤트 테스트', () => {
    it('같은 방의 모든 플레이어에게 메시지 전송', async () => {
      // 방 생성 및 참여 설정
      const createResponse = await new Promise<{ gameId: string }>((resolve) => {
        client1.once(socketEvents.CREATE_ROOM, resolve);
        client1.emit(socketEvents.CREATE_ROOM, {
          title: 'Chat Test Room',
          gameMode: 'RANKING',
          maxPlayerCount: 5,
          isPublicGame: true
        });
      });

      // 플레이어들 입장
      await Promise.all([
        new Promise<void>((resolve) => {
          client1.once(socketEvents.JOIN_ROOM, () => resolve());
          client1.emit(socketEvents.JOIN_ROOM, {
            gameId: createResponse.gameId,
            playerName: 'Player1'
          });
        }),
        new Promise<void>((resolve) => {
          client2.once(socketEvents.JOIN_ROOM, () => resolve());
          client2.emit(socketEvents.JOIN_ROOM, {
            gameId: createResponse.gameId,
            playerName: 'Player2'
          });
        })
      ]);

      // 채팅 메시지 테스트
      const testMessage = 'Hello, everyone!';
      const messagePromises = [
        new Promise<any>((resolve) => client1.once(socketEvents.CHAT_MESSAGE, resolve)),
        new Promise<any>((resolve) => client2.once(socketEvents.CHAT_MESSAGE, resolve))
      ];

      client1.emit(socketEvents.CHAT_MESSAGE, {
        gameId: createResponse.gameId,
        message: testMessage
      });

      const receivedMessages = await Promise.all(messagePromises);
      receivedMessages.forEach((msg) => {
        expect(msg.message).toBe(testMessage);
        expect(msg.playerName).toBe('Player1');
      });
    });
  });

  describe('updatePosition 이벤트 테스트', () => {
    it('위치 업데이트 성공', async () => {
      // 방 생성 및 참여 설정
      const createResponse = await new Promise<{ gameId: string }>((resolve) => {
        client1.once(socketEvents.CREATE_ROOM, resolve);
        client1.emit(socketEvents.CREATE_ROOM, {
          title: 'Chat Test Room',
          gameMode: 'RANKING',
          maxPlayerCount: 5,
          isPublicGame: true
        });
      });

      // 플레이어들 입장
      await Promise.all([
        new Promise<void>((resolve) => {
          client1.once(socketEvents.JOIN_ROOM, () => resolve());
          client1.emit(socketEvents.JOIN_ROOM, {
            gameId: createResponse.gameId,
            playerName: 'Player1'
          });
        }),
        new Promise<void>((resolve) => {
          client2.once(socketEvents.JOIN_ROOM, () => resolve());
          client2.emit(socketEvents.JOIN_ROOM, {
            gameId: createResponse.gameId,
            playerName: 'Player2'
          });
        })
      ]);
      const newPosition = [0.2, 0.5];

      const updateResponse = await new Promise<any>((resolve) => {
        client1.once(socketEvents.UPDATE_POSITION, resolve);
        client1.emit(socketEvents.UPDATE_POSITION, {
          gameId: createResponse.gameId,
          newPosition
        });
      });

      expect(updateResponse.playerPosition).toEqual(newPosition);

      // Redis에서 위치 정보 확인
      const playerData = await redisMock.hgetall(`Player:${client1.id}`);
      expect(parseFloat(playerData.positionX)).toBe(newPosition[0]);
      expect(parseFloat(playerData.positionY)).toBe(newPosition[1]);
    });
  });

  describe('startGame 이벤트 테스트', () => {
    it('게임 시작할 때 초기 설정 성공', async () => {
      // 방 생성 및 참여 설정
      const createResponse = await new Promise<{ gameId: string }>((resolve) => {
        client1.once(socketEvents.CREATE_ROOM, resolve);
        client1.emit(socketEvents.CREATE_ROOM, {
          title: 'Chat Test Room',
          gameMode: 'RANKING',
          maxPlayerCount: 5,
          isPublicGame: true
        });
      });

      // 플레이어들 입장
      await Promise.all([
        new Promise<void>((resolve) => {
          client1.once(socketEvents.JOIN_ROOM, () => resolve());
          client1.emit(socketEvents.JOIN_ROOM, {
            gameId: createResponse.gameId,
            playerName: 'Player1'
          });
        }),
        new Promise<void>((resolve) => {
          client2.once(socketEvents.JOIN_ROOM, () => resolve());
          client2.emit(socketEvents.JOIN_ROOM, {
            gameId: createResponse.gameId,
            playerName: 'Player2'
          });
        })
      ]);
      const gameId = createResponse.gameId;

      client1.emit(socketEvents.START_GAME, {
        gameId
      });

      await new Promise((resolve) => setTimeout(resolve, 1500)); // 1.5초 대기

      const quizSetIds = await redisMock.smembers(REDIS_KEY.ROOM_QUIZ_SET(gameId));

      // 내림차순 조회 (높은 점수부터)
      const leaderboard = await redisMock.zrevrange(REDIS_KEY.ROOM_LEADERBOARD(gameId), 0, -1);

      expect(gameId).toBe(createResponse.gameId);
      expect(quizSetIds.length).toBeGreaterThan(0); // FIX: 추후 더 fit하게 바꾸기
      expect(leaderboard).toBeDefined();
    });
  });
});
