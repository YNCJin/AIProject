import { sound } from '../audio/Sound';
import { artScale, SCREEN, setupCamera } from '../display';
import { Scene } from 'phaser';
import { PALETTE } from '../art/Textures';

//  타이틀 화면: 어둠 속 등불 하나
export class MainMenu extends Scene
{
    constructor ()
    {
        super('MainMenu');
    }

    create ()
    {
        setupCamera(this);
        const { width, height } = SCREEN;
        this.cameras.main.setBackgroundColor(PALETTE.darkness);
        sound.startMusic();

        //  등불지기와 등불 빛
        const glow = this.add.image(width / 2, 300, 'lanternGlow').setScale(artScale(2.4)).setBlendMode(Phaser.BlendModes.ADD);
        this.add.image(width / 2, 300, 'player').setScale(artScale(3));
        this.tweens.add({ targets: glow, scale: artScale(2.7), alpha: 0.75, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

        this.add.text(width / 2, 130, '마지막 등불', {
            fontFamily: 'Arial Black', fontSize: 64, color: '#ffd27a',
            stroke: '#1a1030', strokeThickness: 8
        }).setOrigin(0.5);

        this.add.text(width / 2, 450, '해가 뜨지 않은 지 백 년.\n마을의 등불은 모두 꺼지고, 남은 것은 당신의 등불 하나.', {
            fontFamily: 'Arial, sans-serif', fontSize: 20, color: '#b9b0d6', align: 'center', lineSpacing: 8
        }).setOrigin(0.5);

        const start = this.add.text(width / 2, height - 170, '클릭하여 시작', {
            fontFamily: 'Arial Black', fontSize: 30, color: '#ffffff', stroke: '#000000', strokeThickness: 6
        }).setOrigin(0.5);
        this.tweens.add({ targets: start, alpha: 0.4, duration: 900, yoyo: true, repeat: -1 });

        this.add.text(width / 2, height - 120, '이동: WASD / 방향키   공격은 자동   M: 소리 켜기/끄기', {
            fontFamily: 'Arial, sans-serif', fontSize: 18, color: '#8a82a8'
        }).setOrigin(0.5);

        this.input.once('pointerdown', () => {
            this.scene.start('Game');
        });
    }
}
