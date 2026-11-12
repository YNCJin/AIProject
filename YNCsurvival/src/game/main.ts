import { Boot } from './scenes/Boot';
import { ChatOverlay } from './scenes/ChatOverlay';
import { GameOver } from './scenes/GameOver';
import { Game as MainGame } from './scenes/Game';
import { LevelUp } from './scenes/LevelUp';
import { MainMenu } from './scenes/MainMenu';
import { AUTO, Game, Scale } from 'phaser';
import { CANVAS_HEIGHT, CANVAS_WIDTH, installCrispText } from './display';
import { Preloader } from './scenes/Preloader';
import { sound } from './audio/Sound';

//  Find out more information about the Game Config at:
//  https://docs.phaser.io/api-documentation/typedef/types-core#gameconfig
const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    //  실제 캔버스는 창 크기 x 디스플레이 배율로 크게 만들고(display.ts), 창에 맞춰 가운데 정렬
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    parent: 'game-container',
    backgroundColor: '#04040f',
    scale: {
        mode: Scale.FIT,
        autoCenter: Scale.CENTER_BOTH
    },
    //  부드럽게 그린 그림이 지글거리지 않도록 픽셀아트 모드는 끔
    pixelArt: false,
    //  소리는 audio/Sound.ts 가 Web Audio 로 직접 합성하므로 Phaser 오디오는 끈다
    audio: { noAudio: true },
    antialias: true,
    physics: {
        default: 'arcade',
        arcade: {
            debug: false,
            //  모니터 주사율(120Hz, 144Hz ...)에 맞춰 매 프레임 이동 -> 고주사율에서 끊김 방지
            fixedStep: false
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

    installCrispText();
    sound.install();

    return new Game({ ...config, parent });

}

export default StartGame;
