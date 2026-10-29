import { Scene } from 'phaser';
import { formatTime } from '../utils/format';
import { GameResult } from './Game';

export class GameOver extends Scene
{
    camera: Phaser.Cameras.Scene2D.Camera;
    background: Phaser.GameObjects.Image;
    gameover_text : Phaser.GameObjects.Text;
    result: GameResult;

    constructor ()
    {
        super('GameOver');
    }

    init (data: GameResult)
    {
        this.result = data;
    }

    create ()
    {
        this.camera = this.cameras.main
        this.camera.setBackgroundColor(this.result.cleared ? 0x2e7d32 : 0xff0000);

        this.background = this.add.image(512, 384, 'background');
        this.background.setAlpha(0.5);

        this.gameover_text = this.add.text(512, 300, this.result.cleared ? 'CLEAR!' : 'Game Over', {
            fontFamily: 'Arial Black', fontSize: 64, color: '#ffffff',
            stroke: '#000000', strokeThickness: 8,
            align: 'center'
        });
        this.gameover_text.setOrigin(0.5);

        this.add.text(512, 430,
            `생존 시간: ${formatTime(this.result.survivedMs)}\n레벨: ${this.result.level}\n처치 수: ${this.result.kills}\n\n클릭하여 메인 메뉴로`, {
            fontFamily: 'Arial Black', fontSize: 28, color: '#ffffff',
            stroke: '#000000', strokeThickness: 6,
            align: 'center'
        }).setOrigin(0.5);

        this.input.once('pointerdown', () => {

            this.scene.start('MainMenu');

        });
    }
}
