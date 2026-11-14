/** VS Code 작업 로그: 출력(Output) 패널의 "Yang Coding 작업 로그" 채널. */
import * as vscode from 'vscode';
import { AgentLog } from './agent';

const MARK = { info: '', head: '', tool: '', result: '', error: '[ERROR] ' } as const;

export class OutputAgentLog implements AgentLog {
  readonly channel: vscode.OutputChannel;
  private atLineStart = true;

  constructor() {
    // languageId 'log' → ERROR/시간 등에 색이 입혀짐
    this.channel = vscode.window.createOutputChannel('Yang Coding 작업 로그', 'log');
  }

  line(text: string, level: 'info' | 'head' | 'tool' | 'result' | 'error' = 'info'): void {
    if (!this.atLineStart) this.channel.append('\n');
    this.channel.appendLine(MARK[level] + text);
    this.atLineStart = true;
  }

  raw(text: string): void {
    if (!text) return;
    this.channel.append(text);
    this.atLineStart = text.endsWith('\n');
  }

  show(): void {
    if (vscode.workspace.getConfiguration('localAgent').get<boolean>('showLogOnRequest', true)) {
      this.channel.show(true); // preserveFocus: 채팅 입력 포커스 유지
    }
  }

  dispose() {
    this.channel.dispose();
  }
}
