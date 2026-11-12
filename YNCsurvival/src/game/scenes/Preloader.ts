import { setupCamera } from '../display';
import { Scene } from 'phaser';
import { createTextures } from '../art/Textures';

export class Preloader extends Scene
{
    constructor ()
    {
        super('Preloader');
    }

    init ()
    {
        setupCamera(this);
        //  진행 막대 (외곽선 + 차오르는 금색 막대)
        this.add.rectangle(512, 384, 468, 32).setStrokeStyle(1, 0xffd27a);
        const bar = this.add.rectangle(512 - 230, 384, 4, 28, 0xffd27a);

        this.load.on('progress', (progress: number) => {
            bar.width = 4 + (460 * progress);
        });
    }

    preload ()
    {
        //  픽셀 아트 이미지가 준비되면 여기서 로드 (art/Textures.ts 와 같은 키를 쓰면 코드 그림 대신 사용됨)
        //  예: this.load.image('player', 'assets/player.png');
        this.load.setPath('assets');
    }

    create ()
    {
        createTextures(this);

        //  채팅 오버레이는 다른 씬과 동시에 계속 실행
        this.scene.launch('ChatOverlay');

        this.scene.start('MainMenu');
    }
}
