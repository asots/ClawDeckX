package agentroom

import (
	"ClawDeckX/internal/database"
)

// SettingKeyAuxModel 是全局辅助模型配置的 settings 表 key。
// 管理员通过房间设置弹窗"全局默认"保存；所有房间在未设置自己的 AuxModel 时回退到这里。
const SettingKeyAuxModel = "agentroom.aux_model"

// readAgentRoomAuxModelSetting 读取全局默认 aux model。
// 失败时静默返回空串——调用方再回退到成员主模型。
func readAgentRoomAuxModelSetting() string {
	repo := database.NewSettingRepo()
	v, err := repo.Get(SettingKeyAuxModel)
	if err != nil {
		return ""
	}
	return v
}

// WriteAgentRoomAuxModelSetting 由 handler 层在用户保存全局默认时调用。
func WriteAgentRoomAuxModelSetting(model string) error {
	repo := database.NewSettingRepo()
	return repo.Set(SettingKeyAuxModel, model)
}
