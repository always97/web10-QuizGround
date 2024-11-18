import { Injectable } from '@nestjs/common';
import { GameWsException } from '../../common/exceptions/game.ws.exception';
import { ExceptionMessage } from '../../common/constants/exception-message';

@Injectable()
export class GameValidator {
  validateRoomExists(eventName: string, room: any) {
    if (!room?.title) {
      throw new GameWsException(eventName, ExceptionMessage.ROOM_NOT_FOUND);
    }
  }

  validateRoomCapacity(eventName: string, currentPlayerCount: number, maxPlayerCount: number) {
    if (currentPlayerCount >= maxPlayerCount) {
      throw new GameWsException(eventName, ExceptionMessage.ROOM_FULL);
    }
  }

  validatePlayerInRoom(eventName: string, gameId: string, player: any) {
    if (gameId !== player?.gameId) {
      throw new GameWsException(eventName, ExceptionMessage.NOT_A_PLAYER);
    }
  }

  validatePlayerIsHost(eventName: string, room: any, clientId: string) {
    if (room?.host !== clientId) {
      throw new GameWsException(eventName, ExceptionMessage.ONLY_HOST);
    }
  }

  validateQuizsetCount(eventName: string, selectedQuizsetCount: number, quizsetCount: number) {
    if (selectedQuizsetCount > quizsetCount) {
      throw new GameWsException(eventName, ExceptionMessage.EXCEEDS_QUIZ_SET_LIMIT);
    }
  }
}