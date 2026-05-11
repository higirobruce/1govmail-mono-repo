import { Mark } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      setComment: (anchorId: string) => ReturnType;
      unsetComment: (anchorId: string) => ReturnType;
    };
  }
}

export const CommentMark = Mark.create({
  name: 'comment',

  addAttributes() {
    return {
      anchorId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-cid'),
        renderHTML: (attrs) => ({ 'data-cid': attrs.anchorId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-cid]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, class: 'doc-comment-mark' }, 0];
  },

  addCommands() {
    return {
      setComment:
        (anchorId: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { anchorId }),

      unsetComment:
        (anchorId: string) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.doc.descendants((node, pos) => {
              const mark = node.marks.find(
                (m) => m.type.name === 'comment' && m.attrs.anchorId === anchorId,
              );
              if (mark) {
                tr.removeMark(pos, pos + node.nodeSize, mark.type);
              }
            });
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
