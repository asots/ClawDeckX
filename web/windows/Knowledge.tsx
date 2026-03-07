import React from 'react';
import { Language } from '../types';
import { TemplateManager } from '../components/templates';

interface KnowledgeProps {
  language: Language;
  pendingExpandItem?: string | null;
  onExpandItemConsumed?: () => void;
}

const Knowledge: React.FC<KnowledgeProps> = ({ language, pendingExpandItem, onExpandItemConsumed }) => {
  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-4">
      <TemplateManager
        language={language}
        pendingExpandItem={pendingExpandItem}
        onExpandItemConsumed={onExpandItemConsumed}
      />
    </div>
  );
};

export default Knowledge;
