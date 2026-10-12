import { Scene } from 'phaser';
import { ChatClient, MIDDLEWARE_WS_URL } from '../net/ChatClient';

const MAX_LINES = 8;
const LINE_LIFETIME_MS = 12000;     //  이 시간이 지나면 메시지가 사라짐
const FADE_MS = 500;
const MARGIN = 16;
const LINE_GAP = 4;
const WRAP_WIDTH = 440;

//  메인 메뉴 / 게임 / 게임오버 어느 화면에서든 위에 떠 있는 채팅 오버레이
//  Preloader에서 launch 되며, scene 목록 마지막에 있어서 항상 맨 위에 그려진다
export class ChatOverlay extends Scene
{
    lines: Phaser.GameObjects.Text[];
    client: ChatClient;
    wasConnected: boolean;

    constructor ()
    {
        super('ChatOverlay');
    }

    create ()
    {
        this.lines = [];
        this.wasConnected = false;

        this.client = new ChatClient(MIDDLEWARE_WS_URL, {
            onChat: (message) => this.addLine(`${message.user}: ${message.text}`, '#ffffff'),
            onStatus: (connected) => {
                if (connected)
                {
                    this.addLine('[시스템] 채팅 서버 연결됨', '#81c784');
                }
                else if (this.wasConnected)
                {
                    this.addLine('[시스템] 채팅 서버 연결 끊김 - 재연결 시도 중', '#e57373');
                }
                this.wasConnected = connected;
            }
        });
        this.client.connect();

        this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.client.close());
    }

    addLine (content: string, color: string)
    {
        const line = this.add.text(MARGIN, 0, content, {
            fontFamily: 'Arial, sans-serif', fontSize: 18, color,
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            padding: { x: 8, y: 4 },
            //  한글은 띄어쓰기 없이 길게 이어질 수 있어 advanced wrap 사용
            wordWrap: { width: WRAP_WIDTH, useAdvancedWrap: true }
        }).setOrigin(0, 1);

        this.lines.push(line);
        if (this.lines.length > MAX_LINES)
        {
            this.removeLine(this.lines[0]);
        }

        this.tweens.add({
            targets: line,
            alpha: 0,
            delay: LINE_LIFETIME_MS,
            duration: FADE_MS,
            onComplete: () => this.removeLine(line)
        });

        this.layout();
    }

    removeLine (line: Phaser.GameObjects.Text)
    {
        const index = this.lines.indexOf(line);
        if (index === -1)
        {
            return;
        }

        this.lines.splice(index, 1);
        this.tweens.killTweensOf(line);
        line.destroy();
        this.layout();
    }

    //  최신 메시지가 맨 아래, 위로 쌓이도록 배치
    layout ()
    {
        let y = this.scale.height - MARGIN;
        for (let i = this.lines.length - 1; i >= 0; i--)
        {
            this.lines[i].setY(y);
            y -= this.lines[i].height + LINE_GAP;
        }
    }
}
