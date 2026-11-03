向调度方（Router）汇报当前工单状态。

- state：progress 阶段进展 / ready 做完可验收 / blocked 卡住等人 / failed 失败
- summary：一到三句，说结论和证据，不要写过程流水账
- human_action：只在真的需要人回答时填，一句具体的问题

你是 worker，没有对外说话的通道。想让用户知道的事，全部写进这里，由调度方决定怎么转述。
