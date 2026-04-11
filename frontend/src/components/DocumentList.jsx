import React from 'react'
import { List } from 'react-window'
import {
  Box,
  Collapse,
  Divider,
  ListItem,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material'
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded'
import StatusChip from './StatusChip'

const ITEM_HEIGHT = 50

function DocumentRow({ index, style, documents }) {
  const doc = documents[index]

  return (
    <Box style={style} sx={{ px: 1, py: 0.5, boxSizing: 'border-box' }}>
      <ListItem
        sx={{
          px: 1,
          py: 0.5,
          alignItems: 'center',
          border: index < documents.length - 1 ? '1px solid' : 'none',
          borderColor: 'divider',
        }}
        secondaryAction={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <StatusChip status={doc.status} />
          </Box>
        }
      >
        <ListItemText
          primary={
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 'calc(100% - 120px)',
                fontSize: '0.85rem',
              }}
            >
              {doc.fileName ?? doc.title ?? doc.href ?? 'Untitled'}
            </Typography>
          }
          secondary={
            doc.href ? (
              <Tooltip title={doc.href}>
                <Typography
                  variant="caption"
                  sx={{
                    color: 'text.secondary',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                    fontSize: '0.75rem',
                  }}
                >
                  {doc.href}
                </Typography>
              </Tooltip>
            ) : null
          }
        />
      </ListItem>
    </Box>
  )
}

/**
 * Expandable list of documents for a queue item.
 * @param {{
 *   searchResults: import('../../../shared/types.js').SearchResult[],
 *   isOpen: boolean,
 * }} props
 */
export default function DocumentList({ searchResults, isOpen }) {
  const documents = Array.isArray(searchResults) ? searchResults : []
  const height = Math.min(400, documents.length * ITEM_HEIGHT)

  const Row = React.useCallback(
    ({ index, style }) => <DocumentRow index={index} style={style} documents={documents} />,
    [documents],
  )

  return (
    <Collapse in={isOpen} timeout="auto" unmountOnExit>
      <Box sx={{ p: 1 }}>
        <Divider />
        <Box sx={{ px: 1, py: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <DescriptionRoundedIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <Typography variant="subtitle2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
              Documents ({documents.length})
            </Typography>
          </Box>

          {documents.length === 0 ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', ml: 4 }}>
              No documents found for this query.
            </Typography>
          ) : (
            <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
              <List
                defaultHeight={height}
                rowCount={documents.length}
                rowHeight={ITEM_HEIGHT}
                rowComponent={Row}
                rowProps={{}}
                style={{ width: '100%' }}
              />
            </Box>
          )}
        </Box>
      </Box>
    </Collapse>
  )
}
