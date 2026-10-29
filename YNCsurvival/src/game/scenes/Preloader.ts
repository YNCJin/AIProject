import { Scene } from 'phaser';

export class Preloader extends Scene
{
    constructor ()
    {
        super('Preloader');
    }

    init ()
    {
        //  We loaded this image in our Boot Scene, so we can display it here
        this.add.image(512, 384, 'background');

        //  A simple progress bar. This is the outline of the bar.
        this.add.rectangle(512, 384, 468, 32).setStrokeStyle(1, 0xffffff);

        //  This is the progress bar itself. It will increase in size from the left based on the % of progress.
        const bar = this.add.rectangle(512-230, 384, 4, 28, 0xffffff);

        //  Use the 'progress' event emitted by the LoaderPlugin to update the loading bar
        this.load.on('progress', (progress: number) => {

            //  Update the progress bar (our bar is 464px wide, so 100% = 464px)
            bar.width = 4 + (460 * progress);

        });
    }

    preload ()
    {
        //  Load the assets for the game - Replace with your own assets
        this.load.setPath('assets');

        this.load.image('logo', 'logo.png');
    }

    create ()
    {
        //  When all the assets have loaded, it's often worth creating global objects here that the rest of the game can use.
        //  For example, you can define global animations here, so we can use them in other scenes.

        this.createPlaceholderTextures();

        //  채팅 오버레이는 다른 씬과 동시에 계속 실행
        this.scene.launch('ChatOverlay');

        //  Move to the MainMenu. You could also swap this for a Scene Transition, such as a camera fade.
        this.scene.start('MainMenu');
    }

    //  픽셀 아트 에셋이 준비되기 전까지 사용할 임시 텍스처를 코드로 생성
    //  나중에 preload()에서 같은 키('player', 'enemy' 등)로 이미지를 로드하면 그대로 교체됨
    createPlaceholderTextures ()
    {
        const g = this.add.graphics();

        //  플레이어: 파란 사각형
        g.fillStyle(0x4fc3f7).fillRect(0, 0, 24, 24);
        g.lineStyle(2, 0xffffff).strokeRect(1, 1, 22, 22);
        g.generateTexture('player', 24, 24);
        g.clear();

        //  적: 빨간 원
        g.fillStyle(0xe53935).fillCircle(10, 10, 10);
        g.generateTexture('enemy', 20, 20);
        g.clear();

        //  투사체: 노란 원
        g.fillStyle(0xffeb3b).fillCircle(4, 4, 4);
        g.generateTexture('bullet', 8, 8);
        g.clear();

        //  경험치 보석: 초록 마름모
        g.fillStyle(0x66bb6a);
        g.fillTriangle(5, 0, 10, 6, 0, 6);
        g.fillTriangle(0, 6, 10, 6, 5, 12);
        g.generateTexture('gem', 10, 12);
        g.clear();

        //  큰 경험치 보석 (보스 드롭): 파란 마름모
        g.fillStyle(0x42a5f5);
        g.fillTriangle(8, 0, 16, 10, 0, 10);
        g.fillTriangle(0, 10, 16, 10, 8, 20);
        g.generateTexture('gemBig', 16, 20);
        g.clear();

        //  중간 보스: 보라 원 + 눈
        g.fillStyle(0x8e24aa).fillCircle(24, 24, 24);
        g.lineStyle(3, 0x4a148c).strokeCircle(24, 24, 22);
        g.fillStyle(0xffeb3b).fillCircle(16, 20, 4).fillCircle(32, 20, 4);
        g.generateTexture('midBoss', 48, 48);
        g.clear();

        //  최종 보스: 큰 검붉은 사각형 + 노란 테두리 + 눈
        g.fillStyle(0x7f0000).fillRoundedRect(0, 0, 96, 96, 16);
        g.lineStyle(4, 0xffd600).strokeRoundedRect(2, 2, 92, 92, 14);
        g.fillStyle(0xffd600).fillTriangle(22, 34, 42, 40, 22, 46).fillTriangle(74, 34, 54, 40, 74, 46);
        g.generateTexture('finalBoss', 96, 96);
        g.clear();

        //  보스 탄환: 주황 원
        g.fillStyle(0xff6d00).fillCircle(6, 6, 6);
        g.fillStyle(0xffe0b2).fillCircle(6, 6, 3);
        g.generateTexture('bossBullet', 12, 12);
        g.clear();

        //  바닥 타일: 격자 무늬 (이동감이 보이도록)
        g.fillStyle(0x1a1a2e).fillRect(0, 0, 64, 64);
        g.lineStyle(1, 0x2a2a4a).strokeRect(0, 0, 64, 64);
        g.generateTexture('ground', 64, 64);

        g.destroy();
    }
}
