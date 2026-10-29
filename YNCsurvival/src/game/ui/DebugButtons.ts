export interface DebugButton
{
    label: string;
    onClick: () => void;
}

const MARGIN = 16;
const GAP = 8;

//  테스트용 버튼: 화면 오른쪽 아래(채팅창 반대편)에 세로로 쌓아서 표시
//  config.ts 의 SHOW_DEBUG_BUTTONS 가 true 일 때만 Game 씬에서 생성됨
export function createDebugButtons (scene: Phaser.Scene, buttons: DebugButton[])
{
    const { width, height } = scene.scale;
    let y = height - MARGIN;

    for (const button of [...buttons].reverse())
    {
        const text = scene.add.text(width - MARGIN, y, button.label, {
            fontFamily: 'Arial, sans-serif', fontSize: 16, color: '#ffffff',
            backgroundColor: '#37474f', padding: { x: 12, y: 8 }
        }).setOrigin(1, 1).setScrollFactor(0).setDepth(200).setAlpha(0.85);

        text.setInteractive({ useHandCursor: true })
            .on('pointerover', () => text.setBackgroundColor('#546e7a').setAlpha(1))
            .on('pointerout', () => text.setBackgroundColor('#37474f').setAlpha(0.85))
            .on('pointerdown', button.onClick);

        y -= text.height + GAP;
    }

    scene.add.text(width - MARGIN, y, 'TEST', {
        fontFamily: 'Arial', fontSize: 12, color: '#90a4ae'
    }).setOrigin(1, 1).setScrollFactor(0).setDepth(200);
}
