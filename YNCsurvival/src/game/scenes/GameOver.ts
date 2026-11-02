import { Scene } from 'phaser';
import { PALETTE } from '../art/Textures';
import { formatTime } from '../utils/format';
import { GameResult } from './Game';

//  결과 화면: 등불이 꺼짐(사망) / 새벽(긴 밤 처치)
export class GameOver extends Scene
{
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
        const { width } = this.scale;
        const cleared = this.result.cleared;

        this.cameras.main.setBackgroundColor(cleared ? 0xfff4dc : PALETTE.darkness);

        this.add.text(width / 2, 260, cleared ? '새벽' : '등불이 꺼졌다', {
            fontFamily: 'Arial Black', fontSize: 64, color: cleared ? '#b8742a' : '#8a82a8',
            stroke: cleared ? '#ffffff' : '#000000', strokeThickness: 6
        }).setOrigin(0.5);

        if (cleared)
        {
            this.add.text(width / 2, 330, '등불을 지키던 사람은, 마침내 등불 그 자체가 되었다.', {
                fontFamily: 'Arial, sans-serif', fontSize: 20, color: '#8a5a2a'
            }).setOrigin(0.5);
        }

        const color = cleared ? '#5a3a1a' : '#e8e2f0';
        this.add.text(width / 2, 450,
            `생존 시간: ${formatTime(this.result.survivedMs)}\n레벨: ${this.result.level}\n처치 수: ${this.result.kills}\n\n클릭하여 메인 메뉴로`, {
            fontFamily: 'Arial Black', fontSize: 26, color, align: 'center', lineSpacing: 6
        }).setOrigin(0.5);

        this.input.once('pointerdown', () => {
            this.scene.start('MainMenu');
        });
    }
}
