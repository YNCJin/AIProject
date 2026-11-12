import { GAME_HEIGHT, GAME_WIDTH } from '../display';

//  플레이어 기준 화면 바로 바깥의 원 위 랜덤 위치 (맵은 끝없이 이어지므로 경계 없음)
export function pointAroundPlayer (_scene: Phaser.Scene, player: { x: number; y: number }, extra = 40)
{
    const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
    const distance = Math.hypot(GAME_WIDTH, GAME_HEIGHT) / 2 + extra;
    return {
        x: player.x + Math.cos(angle) * distance,
        y: player.y + Math.sin(angle) * distance
    };
}
