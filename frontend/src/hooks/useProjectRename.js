import { useState } from 'react';
import { projectsApi } from '@/api/projects';

export function useProjectRename({ onRenamed = null, toast = null } = {}) {
  const [editingProjectId, setEditingProjectId] = useState(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingRename, setSavingRename] = useState(false);

  const handleStartRename = (e, project) => {
    if (e?.preventDefault) e.preventDefault();
    if (e?.stopPropagation) e.stopPropagation();
    if (project) {
      setEditingProjectId(project.id);
      setEditingTitle(project.title || '');
    }
  };

  const handleCancelRename = (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (e?.stopPropagation) e.stopPropagation();
    setEditingProjectId(null);
    setEditingTitle('');
  };

  const handleSaveRename = async (e, projectId, customSave) => {
    if (e?.preventDefault) e.preventDefault();
    if (e?.stopPropagation) e.stopPropagation();
    const cleanTitle = editingTitle.trim();
    if (!cleanTitle) {
      if (toast) {
        toast({
          variant: 'destructive',
          title: 'Tên dự án không được để trống',
        });
      }
      return false;
    }
    setSavingRename(true);
    try {
      if (typeof customSave === 'function') {
        await customSave(cleanTitle);
      } else if (projectId) {
        await projectsApi.rename(projectId, cleanTitle);
      }
      if (typeof onRenamed === 'function') {
        onRenamed(projectId, cleanTitle);
      }
      if (toast) {
        toast({
          title: 'Đã đổi tên dự án',
          description: `Dự án đã được đổi tên thành “${cleanTitle}”.`,
        });
      }
      setEditingProjectId(null);
      setEditingTitle('');
      return true;
    } catch (err) {
      if (toast) {
        toast({
          variant: 'destructive',
          title: 'Lỗi đổi tên dự án',
          description: err?.response?.data?.message || err.message,
        });
      } else {
        console.error('Rename error:', err);
      }
      return false;
    } finally {
      setSavingRename(false);
    }
  };

  return {
    editingProjectId,
    setEditingProjectId,
    editingTitle,
    setEditingTitle,
    savingRename,
    handleStartRename,
    handleCancelRename,
    handleSaveRename,
  };
}
