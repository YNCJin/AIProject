import { formatTime } from '../utils/format';

export interface HudState
{
    hp: number;
    maxHp: number;
    playerX: number;
    playerY: number;
    level: number;
    xp: number;
    xpToNext: number;
    elapsedMs: number;
    kills: number;
    build: string;      //  보유 무기 / 패시브 요약
}

const XP_BAR_HEIGHT = 14;
const HP_BAR_WIDTH = 40;
const HP_BAR_HEIGHT = 5;
const HP_BAR_OFFSET_Y = 20;     //  플레이어 중심에서 HP 바까지 거리

//  화면 HUD: 맨 위 경험치 바, 레벨 / 시간 / 처치 수, 보유 목록, 플레이어 발밑 HP 바
export class Hud
{
    private xpBar: Phaser.GameObjects.Graphics;
    private hpBar: Phaser.GameObjects.Graphics;
    private levelText: Phaser.GameObjects.Text;
    private timerText: Phaser.GameObjects.Text;
    private killText: Phaser.GameObjects.Text;
    private buildText: Phaser.GameObjects.Text;

    constructor (private scene: Phaser.Scene)
    {
        const textStyle: Phaser.Types.GameObjects.Text.TextStyle = {
            fontFamily: 'Arial Black', fontSize: 24, color: '#ffffff',
            stroke: '#000000', strokeThickness: 5
        };
        const { width } = scene.scale;

        //  setScrollFactor(0): 카메라가 움직여도 화면에 고정
        this.xpBar = scene.add.graphics().setScrollFactor(0).setDepth(100);

        this.levelText = scene.add.text(16, XP_BAR_HEIGHT + 8, 'Lv.1', textStyle)
            .setScrollFactor(0).setDepth(100);

        this.timerText = scene.add.text(width / 2, XP_BAR_HEIGHT + 8, '00:00', textStyle)
            .setOrigin(0.5, 0).setScrollFactor(0).setDepth(100);

        this.killText = scene.add.text(width - 16, XP_BAR_HEIGHT + 8, 'Kills: 0', textStyle)
            .setOrigin(1, 0).setScrollFactor(0).setDepth(100);

        this.buildText = scene.add.text(16, XP_BAR_HEIGHT + 44, '', {
            fontFamily: 'Arial, sans-serif', fontSize: 16, color: '#ffffff',
            stroke: '#000000', strokeThickness: 4, lineSpacing: 4
        }).setScrollFactor(0).setDepth(100);

        //  HP 바는 월드 좌표에 그려서 플레이어를 따라다님
        this.hpBar = scene.add.graphics().setDepth(11);
    }

    update (state: HudState)
    {
        const { width } = this.scene.scale;

        this.xpBar.clear();
        this.xpBar.fillStyle(0x000000, 0.6).fillRect(0, 0, width, XP_BAR_HEIGHT);
        this.xpBar.fillStyle(0x42a5f5).fillRect(0, 0, width * (state.xp / state.xpToNext), XP_BAR_HEIGHT);

        const x = state.playerX - HP_BAR_WIDTH / 2;
        const y = state.playerY + HP_BAR_OFFSET_Y;
        this.hpBar.clear();
        this.hpBar.fillStyle(0x000000, 0.7).fillRect(x - 1, y - 1, HP_BAR_WIDTH + 2, HP_BAR_HEIGHT + 2);
        const hpRatio = Phaser.Math.Clamp(state.hp / state.maxHp, 0, 1);
        this.hpBar.fillStyle(0xe53935).fillRect(x, y, HP_BAR_WIDTH * hpRatio, HP_BAR_HEIGHT);

        this.levelText.setText(`Lv.${state.level}`);
        this.timerText.setText(formatTime(state.elapsedMs));
        this.killText.setText(`Kills: ${state.kills}`);
        this.buildText.setText(state.build);
    }
}
