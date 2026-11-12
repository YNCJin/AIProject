import { artScale, SCREEN } from '../display';
import { GROUND_TILE_SIZE, GROUND_VARIANTS } from '../art/Textures';
import { DEPTH } from '../config';

//  무한 스크롤 배경
//  화면을 덮을 만큼의 배경 이미지(1024x768 화면 기준 3x3 = 9장)만 만들어 두고,
//  플레이어가 이동해서 칸이 바뀌면 새로 만들지 않고 기존 이미지를 다음 위치로 옮겨 재사용한다
//  각 칸의 무늬는 칸 좌표로 정해지므로 같은 곳에 돌아오면 같은 바닥이 보인다
export class InfiniteBackground
{
    private tiles: Phaser.GameObjects.Image[] = [];
    private cols: number;
    private rows: number;
    private startCol = Number.NaN;
    private startRow = Number.NaN;

    constructor (scene: Phaser.Scene)
    {
        const { width, height } = SCREEN;
        this.cols = Math.ceil(width / GROUND_TILE_SIZE) + 1;
        this.rows = Math.ceil(height / GROUND_TILE_SIZE) + 1;

        for (let i = 0; i < this.cols * this.rows; i++)
        {
            this.tiles.push(scene.add.image(0, 0, 'ground0').setOrigin(0).setDepth(DEPTH.ground).setScale(artScale()));
        }
    }

    get tileCount (): number
    {
        return this.tiles.length;
    }

    //  viewX / viewY: 화면 왼쪽 위의 월드 좌표
    update (viewX: number, viewY: number)
    {
        const startCol = Math.floor(viewX / GROUND_TILE_SIZE);
        const startRow = Math.floor(viewY / GROUND_TILE_SIZE);
        if (startCol === this.startCol && startRow === this.startRow)
        {
            return;     //  칸이 바뀌지 않았으면 아무것도 하지 않음
        }
        this.startCol = startCol;
        this.startRow = startRow;

        for (let r = 0; r < this.rows; r++)
        {
            for (let c = 0; c < this.cols; c++)
            {
                const col = startCol + c;
                const row = startRow + r;
                this.tiles[r * this.cols + c]
                    .setPosition(col * GROUND_TILE_SIZE, row * GROUND_TILE_SIZE)
                    .setTexture(`ground${variantOf(col, row)}`);
            }
        }
    }
}

//  칸 좌표 -> 배경 무늬 번호 (항상 같은 값)
function variantOf (col: number, row: number): number
{
    const h = Math.imul(col, 73856093) ^ Math.imul(row, 19349663);
    return Math.abs(h) % GROUND_VARIANTS;
}
