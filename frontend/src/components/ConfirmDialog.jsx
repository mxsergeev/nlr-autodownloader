import React from 'react'
import PropTypes from 'prop-types'
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  Box,
  Typography,
  CircularProgress,
} from '@mui/material'

/**
 * Reusable confirmation dialog.
 *
 * Props:
 * - open: boolean - whether the dialog is open
 * - title: string - dialog title
 * - content: string | node - content body (if a string, it's rendered inside DialogContentText)
 * - children: node - alternative to `content` for fully custom body
 * - itemLabel: string | node - optional label shown beneath the content (e.g. the item's URL or name)
 * - onClose: fn - called when the dialog should close (cancel/backdrop/escape)
 * - onConfirm: fn - called when the user confirms
 * - confirmText: string - text for the confirm button
 * - cancelText: string - text for the cancel button
 * - loading: boolean - if true, disables actions and shows a small spinner in the confirm button
 * - disableBackdropClick: boolean - when true prevents closing by clicking backdrop or pressing Escape
 * - dialogProps: object - forwarded to the Dialog component
 */
export default function ConfirmDialog({
  open,
  title,
  content,
  children,
  itemLabel,
  onClose,
  onConfirm,
  confirmText,
  cancelText,
  loading,
  disableBackdropClick,
  dialogProps = {},
}) {
  const handleClose = (event, reason) => {
    // If the caller wants to prevent backdrop/escape closes, ignore those reasons
    if (disableBackdropClick && (reason === 'backdropClick' || reason === 'escapeKeyDown')) {
      return
    }
    if (onClose) onClose(event, reason)
  }

  return (
    <Dialog
      open={Boolean(open)}
      onClose={handleClose}
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-description"
      {...dialogProps}
    >
      {title ? <DialogTitle id="confirm-dialog-title">{title}</DialogTitle> : null}
      <DialogContent dividers>
        {children ? (
          children
        ) : content ? (
          <DialogContentText id="confirm-dialog-description">{content}</DialogContentText>
        ) : null}
        {itemLabel ? (
          <Box sx={{ mt: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {itemLabel}
            </Typography>
          </Box>
        ) : null}
      </DialogContent>

      <DialogActions>
        <Button onClick={(e) => onClose && onClose(e)} disabled={loading}>
          {cancelText}
        </Button>

        <Button
          onClick={(e) => onConfirm && onConfirm(e)}
          color="error"
          variant="contained"
          disabled={loading}
          startIcon={
            loading ? (
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <CircularProgress color="inherit" size={16} thickness={5} />
              </Box>
            ) : null
          }
        >
          {loading ? `${confirmText}…` : confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

ConfirmDialog.propTypes = {
  open: PropTypes.bool,
  title: PropTypes.oneOfType([PropTypes.string, PropTypes.node]),
  content: PropTypes.oneOfType([PropTypes.string, PropTypes.node]),
  children: PropTypes.node,
  itemLabel: PropTypes.oneOfType([PropTypes.string, PropTypes.node]),
  onClose: PropTypes.func,
  onConfirm: PropTypes.func,
  confirmText: PropTypes.string,
  cancelText: PropTypes.string,
  loading: PropTypes.bool,
  disableBackdropClick: PropTypes.bool,
  dialogProps: PropTypes.object,
}

ConfirmDialog.defaultProps = {
  open: false,
  title: 'Confirm',
  content: null,
  children: null,
  itemLabel: null,
  onClose: null,
  onConfirm: null,
  confirmText: 'Confirm',
  cancelText: 'Cancel',
  loading: false,
  disableBackdropClick: false,
  dialogProps: {},
}
