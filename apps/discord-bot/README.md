# Discord 봇

Discord 프로세스는 MySQL과 분리되어 있습니다. 전송 대상 행을 기한부로 점유하며, 내부 NestJS 봇 API를 통해 세 가지 조회 전용 슬래시 하위 명령을 제공합니다.

- `/orsem status`
- `/orsem recent [limit]`
- `/orsem company <query>`

`DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_CHANNEL_ID`, 무작위 `DISCORD_SERVICE_TOKEN`을 설정합니다. 개발 중 명령 등록을 빠르게 하려면 선택적으로 `DISCORD_GUILD_ID`를 사용합니다. `DISCORD_ALLOWED_USER_IDS`는 쉼표로 구분한 허용 사용자 목록이며 운영에서는 비워 두지 않습니다.

P1/P2 이벤트는 감지 즉시 알림을 보냅니다. 파싱이 완료되면 원본 Discord 메시지 ID가 있는 경우 해당 메시지를 편집하고, 조회·편집에 실패하면 후속 메시지를 보냅니다. Discord가 메시지를 받은 뒤 수신 확인이 유실될 수 있으므로 외부 전송의 완전한 중복 방지를 보장하지는 않습니다.
