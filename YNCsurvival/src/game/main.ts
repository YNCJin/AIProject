import { Boot } from './scenes/Boot';
import { ChatOverlay } from './scenes/ChatOverlay';
import { GameOver } from './scenes/GameOver';
import { Game as MainGame } from './scenes/Game';
import { LevelUp } from './scenes/LevelUp';
import { MainMenu } from './scenes/MainMenu';
import { AUTO, Game } from 'phaser';
import { Preloader } from './scenes/Preloader';

//  Find out more information about the Game Config at:
//  https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    width: 1024,
    height: 768,
    parent: 'game-container',
    backgroundColor: '#1a1a2e',
    pixelArt: true,
    physics: {
        default: 'arcade',
        arcade: {
            debug: false
        }
    },
    scene: [
        Boot,
        Preloader,
        MainMenu,
        MainGame,
        GameOver,
        LevelUp,        //  Game 위에 겹쳐 그려지도록 Game 뒤에 둔다
        ChatOverlay     //  항상 맨 위에 그려지도록 마지막에 둔다
    ]
};

const StartGame = (parent: string) => {

    return new Game({ ...config, parent });

}

export default StartGame;
